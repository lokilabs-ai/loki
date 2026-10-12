import assert from "node:assert/strict";
import test from "node:test";
import { Client, type Session as NakamaSession } from "@heroiclabs/nakama-js";
import WebSocket from "ws";
import {
  FirstPartyTransport,
  LokiClient,
  type RealtimeRoom,
  type Lobby,
  type LobbyRoom,
} from "../packages/sdk-js/src/index.js";

globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

const HOST = process.env.NAKAMA_HOST ?? "127.0.0.1";
const PORT = process.env.NAKAMA_PORT ?? "7350";
const SERVER_KEY = process.env.NAKAMA_SERVER_KEY ?? "defaultkey";
const HTTP_KEY = process.env.NAKAMA_HTTP_KEY ?? "defaulthttpkey";
const SSL = process.env.NAKAMA_SSL === "true";
const HTTP_PROTOCOL = SSL ? "https" : "http";

type LivePlayer = {
  client: LokiClient;
  transport: FirstPartyTransport;
  close: () => Promise<void>;
};

const waitForNakama = async (): Promise<void> => {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${HTTP_PROTOCOL}://${HOST}:${PORT}/healthcheck`);
      if (response.ok) return;
      lastError = new Error(`healthcheck returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Nakama did not become healthy: ${String(lastError)}`);
};

const provisionTenant = async (userId: string, projectId: string): Promise<void> => {
  const response = await fetch(
    `${HTTP_PROTOCOL}://${HOST}:${PORT}/v2/rpc/loki_provision_tenant?unwrap`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${HTTP_KEY}:`).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userId,
        projectId,
        status: "active",
        maxPlayers: 8,
        tickRate: 5,
        visibility: "matchmaking",
        teamSize: 0,
        inviteTtlSeconds: 900,
        concurrentRoomQuota: 20,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`tenant provisioning failed: ${await response.text()}`);
  }
};

const livePlayer = async (suffix: string, projectId: string, runId: string): Promise<LivePlayer> => {
  const nakama = new Client(SERVER_KEY, HOST, PORT, SSL);
  const session = await nakama.authenticateCustom(
    `loki-sdk-${runId}-${suffix}`,
    true,
    `sdk_${suffix}_${runId}`.slice(0, 128),
  );
  if (!session.user_id || !session.token) throw new Error("Nakama did not return a session");
  await provisionTenant(session.user_id, projectId);
  const restored: NakamaSession = session;
  const transport = new FirstPartyTransport({
    nakamaHost: HOST,
    nakamaPort: PORT,
    nakamaServerKey: SERVER_KEY,
    secure: SSL,
    nakamaClient: nakama,
    sessionProvider: async () => ({
      token: restored.token,
      refreshToken: restored.refresh_token,
      playerId: restored.user_id!,
    }),
  });
  const client = new LokiClient({ projectId, transport });
  await client.authenticate("local");
  return {
    client,
    transport,
    close: () => transport.close(),
  };
};

const until = async (predicate: () => boolean, label: string, timeoutMs = 8_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
};

test("the lobby matchmakes two SDK clients through local Nakama", async (t) => {
  await waitForNakama();
  const runId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const [host, guest] = await Promise.all([
    livePlayer("host", projectId, runId),
    livePlayer("guest", projectId, runId),
  ]);
  const lobbies: Array<Lobby<LobbyRoom>> = [];
  t.after(async () => {
    await Promise.all(lobbies.map((lobby) => lobby.leave().catch(() => undefined)));
    await Promise.all([host.close(), guest.close()]);
  });

  const roomOptions = {
    initialState: { n: 0 },
    reduce: (state: { n: number }, action: { d: number }) => ({ n: state.n + action.d }),
  };
  const hostLobby = host.client.createLobby({
    makeRoom: () => host.client.createSynchronizedRoom(roomOptions),
    minPlayers: 2,
  });
  const guestLobby = guest.client.createLobby({
    makeRoom: () => guest.client.createSynchronizedRoom(roomOptions),
    minPlayers: 2,
  });
  lobbies.push(hostLobby, guestLobby);

  await Promise.all([
    hostLobby.matchmake({ minPlayers: 2, maxPlayers: 2 }),
    guestLobby.matchmake({ minPlayers: 2, maxPlayers: 2 }),
  ]);
  await until(
    () => hostLobby.getState().phase === "ready" && guestLobby.getState().phase === "ready",
    "both lobbies ready",
  );

  const hostRoom = hostLobby.getRoom()?.getSnapshot();
  const guestRoom = guestLobby.getRoom()?.getSnapshot();
  assert.ok(hostRoom?.roomId);
  assert.equal(hostRoom?.roomId, guestRoom?.roomId);
  assert.equal(hostRoom?.members.length, 2);
  assert.equal(guestRoom?.members.length, 2);
  assert.equal(hostRoom?.connection, "connected");
  assert.equal(guestRoom?.connection, "connected");
});

test("a realtime room joins and delivers a host snapshot through local Nakama", async (t) => {
  await waitForNakama();
  const runId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const [host, guest] = await Promise.all([
    livePlayer("rt-host", projectId, runId),
    livePlayer("rt-guest", projectId, runId),
  ]);
  const lobbies: Array<Lobby<RealtimeRoom<{ n: number }, { throttle: number }>>> = [];
  t.after(async () => {
    await Promise.all(lobbies.map((lobby) => lobby.leave().catch(() => undefined)));
    await Promise.all([host.close(), guest.close()]);
  });

  const hostLobby = host.client.createLobby({
    makeRoom: () => host.client.createRealtimeRoom<{ n: number }, { throttle: number }>({ snapshotHz: 10 }),
    minPlayers: 2,
  });
  const guestLobby = guest.client.createLobby({
    makeRoom: () => guest.client.createRealtimeRoom<{ n: number }, { throttle: number }>({ snapshotHz: 10 }),
    minPlayers: 2,
  });
  lobbies.push(hostLobby, guestLobby);

  await hostLobby.createPrivate();
  const inviteCode = hostLobby.getState().room?.inviteCode;
  assert.ok(inviteCode, JSON.stringify(hostLobby.getState()));
  await guestLobby.joinWithCode(inviteCode);
  await until(
    () => hostLobby.getState().phase === "ready" && guestLobby.getState().phase === "ready",
    "both realtime lobbies ready",
  );

  const hostRoom = hostLobby.getRoom();
  const guestRoom = guestLobby.getRoom();
  assert.ok(hostRoom && guestRoom);
  assert.equal(hostRoom.getSnapshot().roomId, guestRoom.getSnapshot().roomId);
  assert.equal(hostRoom.isHost, true);
  assert.equal(guestRoom.isHost, false);

  hostRoom.publishSnapshot({ n: 4 }, { simulationTick: 1 });
  await until(
    () => guestRoom.getSnapshot().state?.n === 4,
    "guest snapshot state",
  );
  assert.deepEqual(guestRoom.getSnapshot().state, { n: 4 });
});
