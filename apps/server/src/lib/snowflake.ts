const EPOCH = 1_672_531_200_000n; // 2023-01-01T00:00:00.000Z
let sequence = 0n;
let lastTimestamp = 0n;
const MACHINE_ID = BigInt(Number(process.env.SNOWFLAKE_MACHINE_ID ?? 1) & 0x3ff);

export const nextSnowflake = (): bigint => {
  let now = BigInt(Date.now());

  if (now === lastTimestamp) {
    sequence = (sequence + 1n) & 0xfffn;
    if (sequence === 0n) {
      while ((now = BigInt(Date.now())) <= lastTimestamp) {
        // busy wait for next millisecond
      }
    }
  } else {
    sequence = 0n;
  }

  lastTimestamp = now;
  const timestampPart = (now - EPOCH) << 22n;
  const machinePart = MACHINE_ID << 12n;
  const id = timestampPart | machinePart | sequence;
  return id;
};
