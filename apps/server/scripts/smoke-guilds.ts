const API_BASE = process.env.SMOKE_API_BASE ?? "http://localhost:3001";
const WS_BASE = API_BASE.replace(/^http/i, "ws") + "/gateway";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
};

const randomTag = Math.random().toString(36).slice(2, 10);

const parseJson = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
};

const getCookieHeader = (response: Response): string => {
  const setCookieGetter = response.headers as Headers & { getSetCookie?: () => string[] };
  const rawCookies = setCookieGetter.getSetCookie?.() ?? [];

  if (rawCookies.length > 0) {
    return rawCookies.map(cookie => cookie.split(";")[0] ?? "").filter(Boolean).join("; ");
  }

  const single = response.headers.get("set-cookie");
  if (!single) {
    throw new Error("No Set-Cookie header found.");
  }

  return single
    .split(",")
    .map(chunk => chunk.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
};

type Session = {
  email: string;
  cookie: string;
};

const signUp = async (email: string, password: string, name: string): Promise<Session> => {
  const response = await fetch(`${API_BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify({
      email,
      password,
      name,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Sign up failed (${response.status}): ${text}`);
  }

  return {
    email,
    cookie: getCookieHeader(response),
  };
};

const authedFetch = async <T>(session: Session, path: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie: session.cookie,
      ...(init?.headers ?? {}),
    },
  });

  return {
    status: response.status,
    body: await parseJson<T>(response),
  };
};

type DispatchPacket = {
  t: string;
  d: unknown;
  s: number;
};

type GatewayClient = {
  events: DispatchPacket[];
  waitFor: (eventName: string, timeoutMs?: number, predicate?: (payload: unknown) => boolean) => Promise<DispatchPacket>;
  close: () => void;
};

const connectGateway = async (session: Session): Promise<GatewayClient> => {
  const tokenResponse = await authedFetch<{ token: string }>(session, "/api/gateway/token", { method: "POST", body: "{}" });
  assert(tokenResponse.status === 200, "gateway token route should return 200");

  const token = tokenResponse.body.token;
  assert(typeof token === "string" && token.length > 10, "gateway token should be returned");

  const ws = new WebSocket(WS_BASE);
  const events: DispatchPacket[] = [];
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let helloReceived = false;

  ws.onmessage = event => {
    const packet = JSON.parse(String(event.data)) as {
      op: number;
      d?: unknown;
      s?: number | null;
      t?: string | null;
    };

    if (packet.op === 10) {
      helloReceived = true;
      const interval = Number((packet.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval ?? 25000);
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      heartbeatTimer = setInterval(() => {
        ws.send(JSON.stringify({ op: 1, d: null }));
      }, interval);

      ws.send(
        JSON.stringify({
          op: 2,
          d: {
            token,
            properties: {
              os: "linux",
              browser: "smoke-script",
              device: "smoke-script",
            },
            intents: 0,
          },
        }),
      );
      return;
    }

    if (packet.op === 0 && packet.t && typeof packet.s === "number") {
      events.push({
        t: packet.t,
        d: packet.d,
        s: packet.s,
      });
    }
  };

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("WebSocket open timeout."));
    }, 5000);

    ws.onopen = () => {
      clearTimeout(timeout);
      resolve();
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket connection failed."));
    };
  });

  const waitFor = async (
    eventName: string,
    timeoutMs = 6000,
    predicate?: (payload: unknown) => boolean,
  ): Promise<DispatchPacket> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const match = events.find(event => event.t === eventName && (!predicate || predicate(event.d)));
      if (match) {
        return match;
      }
      await sleep(100);
    }

    throw new Error(`Timed out waiting for ${eventName} event.`);
  };

  const ensureHello = async (): Promise<void> => {
    const startedAt = Date.now();
    while (!helloReceived && Date.now() - startedAt < 4000) {
      await sleep(50);
    }
    assert(helloReceived, "gateway should send HELLO");
  };

  await ensureHello();

  return {
    events,
    waitFor,
    close: () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      ws.close();
    },
  };
};

const run = async (): Promise<void> => {
  const password = "password123";
  const userA = await signUp(`guild-a-${randomTag}@mail.com`, password, "Guild A");
  const userB = await signUp(`guild-b-${randomTag}@mail.com`, password, "Guild B");

  await authedFetch(userA, "/api/users/@me/profile", {
    method: "PUT",
    body: JSON.stringify({ username: `guilda_${randomTag}`.slice(0, 20), display_name: "Guild A" }),
  });

  await authedFetch(userB, "/api/users/@me/profile", {
    method: "PUT",
    body: JSON.stringify({ username: `guildb_${randomTag}`.slice(0, 20), display_name: "Guild B" }),
  });

  const wsA = await connectGateway(userA);
  await wsA.waitFor("READY");

  const createGuild = await authedFetch<{ id: string; name: string; owner_id: string; icon: string | null }>(
    userA,
    "/api/guilds",
    {
      method: "POST",
      body: JSON.stringify({ name: `Smoke Guild ${randomTag}` }),
    },
  );

  assert(createGuild.status === 201, "creating guild should return 201");
  const guildId = createGuild.body.id;
  assert(typeof guildId === "string" && guildId.length > 0, "guild id must be present");

  const listGuilds = await authedFetch<Array<{ id: string }>>(userA, "/api/users/@me/guilds");
  assert(listGuilds.status === 200, "listing guilds should return 200");
  assert(listGuilds.body.some(guild => guild.id === guildId), "created guild should appear in /users/@me/guilds");

  const guildChannels = await authedFetch<Array<{ id: string; type: number; name: string }>>(userA, `/api/guilds/${guildId}/channels`);
  assert(guildChannels.status === 200, "listing guild channels should return 200");
  const defaultCategory = guildChannels.body.find(channel => channel.type === 4 && channel.name === "Text Channels");
  const generalChannel = guildChannels.body.find(channel => channel.type === 0 && channel.name === "general");
  assert(defaultCategory, "default category should exist");
  assert(generalChannel, "default general channel should exist");

  const createCategory = await authedFetch<{ id: string }>(userA, `/api/guilds/${guildId}/channels`, {
    method: "POST",
    body: JSON.stringify({
      name: "Projects",
      type: 4,
    }),
  });
  assert(createCategory.status === 201, "creating category should return 201");

  const createText = await authedFetch<{ id: string; parent_id: string | null }>(userA, `/api/guilds/${guildId}/channels`, {
    method: "POST",
    body: JSON.stringify({
      name: "build-log",
      type: 0,
      parent_id: createCategory.body.id,
    }),
  });
  assert(createText.status === 201, "creating text channel should return 201");
  assert(createText.body.parent_id === createCategory.body.id, "text channel parent_id should match created category");

  const nonMemberAccess = await authedFetch<{ error: string }>(userB, `/api/guilds/${guildId}`);
  assert(nonMemberAccess.status === 403, "non-member should not fetch guild");

  const createInvite = await authedFetch<{ code: string }>(userA, `/api/channels/${createText.body.id}/invites`, {
    method: "POST",
    body: "{}",
  });
  assert(createInvite.status === 201, "creating invite should return 201");
  assert(typeof createInvite.body.code === "string", "invite code should be returned");

  const inviteCode = createInvite.body.code;

  const invitePreview = await authedFetch<{ code: string; guild: { id: string } }>(userB, `/api/invites/${inviteCode}?with_counts=true`);
  assert(invitePreview.status === 200, "invite preview should return 200");
  assert(invitePreview.body.guild.id === guildId, "invite preview guild should match");

  const acceptInvite = await authedFetch<{ guildId: string; channelId: string }>(userB, `/api/invites/${inviteCode}/accept`, {
    method: "POST",
    body: "{}",
  });
  assert(acceptInvite.status === 200, "accept invite should return 200");
  assert(acceptInvite.body.guildId === guildId, "accept invite should return target guild");

  const memberAccess = await authedFetch<Array<{ id: string }>>(userB, `/api/guilds/${guildId}/channels`);
  assert(memberAccess.status === 200, "joined user should fetch guild channels");

  const wsB = await connectGateway(userB);
  await wsB.waitFor("READY");
  await wsB.waitFor("GUILD_CREATE", 6000, payload => {
    if (!payload || typeof payload !== "object") {
      return false;
    }
    return (payload as { id?: string }).id === guildId;
  });

  const createRealtimeChannel = await authedFetch<{ id: string }>(userA, `/api/guilds/${guildId}/channels`, {
    method: "POST",
    body: JSON.stringify({
      name: "realtime-check",
      type: 0,
      parent_id: createCategory.body.id,
    }),
  });
  assert(createRealtimeChannel.status === 201, "owner should create realtime test channel");

  await wsB.waitFor("CHANNEL_CREATE", 6000, payload => {
    if (!payload || typeof payload !== "object") {
      return false;
    }
    return (payload as { id?: string }).id === createRealtimeChannel.body.id;
  });

  wsA.close();
  wsB.close();

  console.log("Smoke checks passed:");
  console.log("1) Guild create => owner membership + default channels");
  console.log("2) /users/@me/guilds includes created guild");
  console.log("3) category + child text channel create works");
  console.log("4) non-member guild access denied");
  console.log("5) gateway READY + GUILD_CREATE + CHANNEL_CREATE fanout verified");
  console.log("6) invite preview + accept join flow verified");
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
