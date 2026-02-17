import { describe, expect, it } from "bun:test";
import { routes } from "./routes";

describe("route guards", () => {
  it("returns 405 for unsupported PUT /api/guilds/:guildId/channels", async () => {
    const response = await routes["/api/guilds/:guildId/channels"].PUT(
      new Request("http://localhost/api/guilds/123/channels", { method: "PUT" }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, POST, PATCH");

    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toBe("Method not allowed");
  });

  it("returns 405 for unsupported PATCH /api/channels/:channelId/messages", async () => {
    const response = await routes["/api/channels/:channelId/messages"].PATCH(
      new Request("http://localhost/api/channels/555/messages", { method: "PATCH" }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, POST");

    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toBe("Method not allowed");
  });
});
