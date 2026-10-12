import assert from "node:assert/strict";
import test from "node:test";
import {
  createLobby,
  LobbyError,
  type LobbyClient,
  type LobbyRoom,
  type LobbyRoomSnapshot,
  type RealtimeRoom,
  type SynchronizedRoom,
} from "../packages/sdk-js/src/index.js";

// The real room classes must keep satisfying the lobby's room interface.
export const roomsSatisfyLobby = (
  synchronized: SynchronizedRoom<object, object>,
  realtime: RealtimeRoom<object, object>,
): LobbyRoom[] => [synchronized, realtime];

type Deferred<T = void> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};
const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class FakeRoom implements LobbyRoom {
  static all: FakeRoom[] = [];
  static log: string[] = [];
  id = `room-${FakeRoom.all.length + 1}`;
  connection: LobbyRoomSnapshot["connection"] = "idle";
  members: LobbyRoomSnapshot["members"] = [];
  listeners = new Set<(snapshot: LobbyRoomSnapshot) => void>();
  gate?: Deferred;
  failNext?: Error;
  leaveFails = 0;
  leaves = 0;
  signal?: AbortSignal;
  lastCreate?: unknown;
  lastJoin?: unknown;

  constructor() {
    FakeRoom.all.push(this);
  }

  snapshot(): LobbyRoomSnapshot {
    return {
      roomId: this.id,
      inviteCode: "123456",
      playerId: "me",
      hostId: "me",
      members: this.members,
      connection: this.connection,
    };
  }
  getSnapshot(): LobbyRoomSnapshot {
    return this.snapshot();
  }
  subscribe(listener: (snapshot: LobbyRoomSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(): void {
    for (const listener of [...this.listeners]) listener(this.snapshot());
  }
  setMembers(ids: string[]): void {
    this.members = ids.map((playerId) => ({
      playerId,
      sessionId: `s-${playerId}`,
      joinedAt: 1,
      host: playerId === "me",
    }));
    this.emit();
  }
  async enter(label: string): Promise<void> {
    FakeRoom.log.push(`${label}:${this.id}`);
    this.connection = "joining";
    if (this.gate) await this.gate.promise;
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      this.connection = "failed";
      throw error;
    }
    this.connection = "connected";
    this.members = [{ playerId: "me", sessionId: "s-me", joinedAt: 1, host: true }];
  }
  async create(input?: unknown): Promise<unknown> {
    this.lastCreate = input;
    await this.enter("create");
    return undefined;
  }
  async join(input: { inviteCode: string }): Promise<unknown> {
    this.lastJoin = input;
    await this.enter("join");
    return undefined;
  }
  async joinPublic(input: { roomId: string }): Promise<unknown> {
    this.lastJoin = input;
    await this.enter("joinPublic");
    return undefined;
  }
  async matchmake(
    _input: { minPlayers: number; maxPlayers: number; teamSize?: number },
    options?: { signal?: AbortSignal },
  ): Promise<unknown> {
    this.signal = options?.signal;
    FakeRoom.log.push(`matchmake:${this.id}`);
    this.connection = "joining";
    if (this.gate) {
      await Promise.race([
        this.gate.promise,
        new Promise<never>((_, reject) =>
          options?.signal?.addEventListener("abort", () => reject(new Error("search cancelled"))),
        ),
      ]);
    }
    this.connection = "connected";
    this.members = [
      { playerId: "me", sessionId: "s-me", joinedAt: 1, host: true },
      { playerId: "you", sessionId: "s-you", joinedAt: 1, host: false },
    ];
    return undefined;
  }
  async leave(): Promise<void> {
    FakeRoom.log.push(`leave:${this.id}`);
    this.leaves += 1;
    if (this.leaveFails > 0) {
      this.leaveFails -= 1;
      throw new Error("leave failed");
    }
    this.connection = "closed";
    this.members = [];
  }
}

const reset = (): void => {
  FakeRoom.all = [];
  FakeRoom.log = [];
};

const fakeClient = (overrides: Partial<LobbyClient> = {}): LobbyClient => ({
  listPublicRooms: async () => ({ rooms: [] }),
  listLeaderboard: async (leaderboardId) => ({ leaderboardId, records: [] }),
  submitLeaderboardScore: async (_id, score, options) => ({
    playerId: "me",
    displayName: options?.displayName,
    score,
    subscore: options?.subscore ?? 0,
    rank: 1,
  }),
  ...overrides,
});

const lobbyWith = (
  options: Partial<Parameters<typeof createLobby<FakeRoom>>[0]> = {},
): ReturnType<typeof createLobby<FakeRoom>> =>
  createLobby<FakeRoom>({
    client: fakeClient(),
    makeRoom: () => new FakeRoom(),
    minPlayers: 2,
    timeoutMs: 40,
    searchTimeoutMs: 80,
    ...options,
  });

test("a private room waits for the roster, then becomes ready", async () => {
  reset();
  const lobby = lobbyWith();
  const phases: string[] = [];
  lobby.subscribe((state) => phases.push(state.phase));

  await lobby.createPrivate();
  const state = lobby.getState();
  assert.equal(state.phase, "waiting");
  assert.equal(state.room?.inviteCode, "123456");
  assert.equal(state.room?.playerCount, 1);
  assert.equal(state.room?.minPlayers, 2);
  assert.deepEqual(FakeRoom.all[0]?.lastCreate, { visibility: "private" });
  assert.deepEqual(phases, ["creating", "waiting"]);

  FakeRoom.all[0]!.setMembers(["me", "you"]);
  assert.equal(lobby.getState().phase, "ready");
  assert.equal(lobby.getState().room?.playerCount, 2);

  FakeRoom.all[0]!.setMembers(["you"]);
  assert.equal(lobby.getState().phase, "waiting", "the local player must be seated");
  assert.equal(lobby.getRoom(), FakeRoom.all[0]);
});

test("a short reconnect does not undo ready", async () => {
  reset();
  const lobby = lobbyWith();
  await lobby.createPrivate();
  FakeRoom.all[0]!.setMembers(["me", "you"]);
  FakeRoom.all[0]!.connection = "reconnecting";
  FakeRoom.all[0]!.emit();
  assert.equal(lobby.getState().phase, "ready");
  assert.equal(lobby.getState().room?.connection, "reconnecting");
});

test("a public room is created with a mode label", async () => {
  reset();
  const lobby = lobbyWith();
  await lobby.createPublic({ modeLabel: "ranked" });
  assert.deepEqual(FakeRoom.all[0]?.lastCreate, { visibility: "public", modeLabel: "ranked" });
  await lobby.leave();
  await lobby.createPublic();
  assert.deepEqual(FakeRoom.all[1]?.lastCreate, { visibility: "public" });
});

test("leave completes before the next entry, and every entry gets a fresh room", async () => {
  reset();
  const lobby = lobbyWith();
  await lobby.createPrivate();
  await lobby.joinWithCode(" 654321 ");
  assert.deepEqual(FakeRoom.log, ["create:room-1", "leave:room-1", "join:room-2"]);
  assert.equal(FakeRoom.all.length, 2);
  assert.deepEqual(FakeRoom.all[1]?.lastJoin, { inviteCode: "654321" });
  assert.equal(lobby.getRoom(), FakeRoom.all[1]);

  await lobby.joinPublic("room-abc");
  assert.deepEqual(FakeRoom.log.slice(-2), ["leave:room-2", "joinPublic:room-3"]);
  assert.deepEqual(FakeRoom.all[2]?.lastJoin, { roomId: "room-abc" });
});

test("a second entry while one is in flight is ignored", async () => {
  reset();
  const lobby = lobbyWith({ makeRoom: () => {
    const room = new FakeRoom();
    room.gate = deferred();
    return room;
  } });
  const first = lobby.createPrivate();
  await tick();
  await lobby.createPrivate();
  await lobby.joinWithCode("111111");
  assert.equal(FakeRoom.all.length, 1);
  assert.equal(lobby.getState().phase, "creating");
  FakeRoom.all[0]!.gate!.resolve();
  await first;
  assert.equal(lobby.getState().phase, "waiting");
});

test("an empty invite code is an error and creates no room", async () => {
  reset();
  const lobby = lobbyWith();
  await lobby.joinWithCode("   ");
  assert.equal(lobby.getState().phase, "error");
  assert.equal(lobby.getState().error, "enter an invite code");
  assert.equal(FakeRoom.all.length, 0);
  await lobby.leave();
  assert.equal(lobby.getState().phase, "menu");
  assert.equal(lobby.getState().error, undefined);
});

test("a failed join reports the error and leaves the lobby usable", async () => {
  reset();
  const lobby = lobbyWith({
    makeRoom: () => {
      const room = new FakeRoom();
      if (FakeRoom.all.length === 1) room.failNext = new Error("room is full");
      return room;
    },
  });
  await lobby.joinPublic("room-x");
  assert.equal(lobby.getState().phase, "error");
  assert.equal(lobby.getState().error, "room is full");
  assert.equal(lobby.getRoom(), undefined);
  await lobby.createPrivate();
  assert.equal(lobby.getState().phase, "waiting");
  assert.equal(lobby.getState().error, undefined);
});

test("a join that never settles times out, and a late landing gives the seat back", async () => {
  reset();
  const lobby = lobbyWith({
    makeRoom: () => {
      const room = new FakeRoom();
      room.gate = deferred();
      return room;
    },
  });
  await lobby.joinWithCode("123456");
  assert.equal(lobby.getState().phase, "error");
  assert.equal(lobby.getState().error, "timed out");
  assert.equal(lobby.getRoom(), undefined);
  assert.equal(FakeRoom.all[0]!.leaves, 0);

  FakeRoom.all[0]!.gate!.resolve();
  await tick(5);
  assert.equal(FakeRoom.all[0]!.leaves, 1, "the late room is released exactly once");
  assert.equal(lobby.getState().phase, "error");
});

test("cancelSearch aborts the search and returns to the menu after the room is released", async () => {
  reset();
  const lobby = lobbyWith({
    makeRoom: () => {
      const room = new FakeRoom();
      room.gate = deferred();
      return room;
    },
  });
  const search = lobby.matchmake({ minPlayers: 2, maxPlayers: 2 });
  await tick();
  assert.equal(lobby.getState().phase, "searching");
  const signal = FakeRoom.all[0]!.signal!;
  assert.equal(signal.aborted, false);

  await lobby.cancelSearch();
  await search;
  assert.equal(signal.aborted, true);
  assert.equal(lobby.getState().phase, "menu");
  assert.equal(lobby.getState().error, undefined);
  assert.equal(FakeRoom.all[0]!.leaves, 1);
  assert.equal(lobby.getRoom(), undefined);

  // Cancelling again, or when idle, does nothing.
  await lobby.cancelSearch();
  assert.equal(FakeRoom.all[0]!.leaves, 1);
});

test("a search that finds a match becomes ready using its own minimum", async () => {
  reset();
  const lobby = lobbyWith({ minPlayers: 4 });
  await lobby.matchmake({ minPlayers: 2, maxPlayers: 2, teamSize: 1 });
  assert.equal(lobby.getState().phase, "ready");
  assert.equal(lobby.getState().room?.minPlayers, 2);
});

test("a search that runs too long times out", async () => {
  reset();
  const lobby = lobbyWith({
    searchTimeoutMs: 20,
    makeRoom: () => {
      const room = new FakeRoom();
      room.gate = deferred();
      return room;
    },
  });
  await lobby.matchmake({ minPlayers: 2, maxPlayers: 2 });
  assert.equal(lobby.getState().phase, "error");
  assert.equal(lobby.getState().error, "timed out");
  assert.equal(FakeRoom.all[0]!.signal?.aborted, true);
});

test("matchmake rejects impossible player counts", async () => {
  reset();
  const lobby = lobbyWith();
  await assert.rejects(lobby.matchmake({ minPlayers: 3, maxPlayers: 2 }), LobbyError);
  await assert.rejects(lobby.matchmake({ minPlayers: 0, maxPlayers: 2 }), LobbyError);
  assert.equal(FakeRoom.all.length, 0);
});

test("a failed leave keeps the room, blocks new entries, and can be retried", async () => {
  reset();
  const lobby = lobbyWith();
  await lobby.createPrivate();
  FakeRoom.all[0]!.leaveFails = 2;

  await lobby.leave();
  assert.equal(lobby.getState().phase, "error");
  assert.match(lobby.getState().error ?? "", /could not leave the room: leave failed/);
  assert.equal(lobby.getRoom(), FakeRoom.all[0]);

  // A new entry retries the leave first; while that still fails, no new room is made.
  await lobby.createPublic();
  assert.equal(FakeRoom.all.length, 1, "no new room while the old one is still held");
  assert.equal(lobby.getState().phase, "error");

  await lobby.leave();
  assert.equal(lobby.getState().phase, "menu");
  assert.equal(lobby.getRoom(), undefined);
  assert.equal(FakeRoom.all[0]!.leaves, 3);
});

test("an entry after a failed leave retries the leave and then proceeds", async () => {
  reset();
  const lobby = lobbyWith();
  await lobby.createPrivate();
  FakeRoom.all[0]!.leaveFails = 1;
  await lobby.leave();
  assert.equal(lobby.getState().phase, "error");

  await lobby.createPublic();
  assert.equal(FakeRoom.all.length, 2);
  assert.equal(FakeRoom.all[0]!.leaves, 2);
  assert.equal(lobby.getState().phase, "waiting");
  assert.equal(lobby.getRoom(), FakeRoom.all[1]);
});

test("a lost room connection becomes an error with the room's message", async () => {
  reset();
  const lobby = lobbyWith();
  await lobby.createPrivate();
  FakeRoom.all[0]!.connection = "failed";
  (FakeRoom.all[0] as FakeRoom & { lastError?: Error }).lastError = new Error("socket closed");
  const snapshot = FakeRoom.all[0]!.snapshot();
  snapshot.lastError = new Error("socket closed");
  for (const listener of [...FakeRoom.all[0]!.listeners]) listener(snapshot);
  assert.equal(lobby.getState().phase, "error");
  assert.equal(lobby.getState().error, "socket closed");
  await lobby.joinWithCode("123456");
  assert.equal(FakeRoom.all.length, 2);
  assert.equal(FakeRoom.all[0]!.leaves, 1, "the failed room is left before the next entry");
});

test("leave during creating releases the room and returns to the menu", async () => {
  reset();
  const lobby = lobbyWith({
    timeoutMs: 500,
    makeRoom: () => {
      const room = new FakeRoom();
      room.gate = deferred();
      return room;
    },
  });
  const entering = lobby.createPrivate();
  await tick();
  assert.equal(lobby.getState().phase, "creating");
  const leaving = lobby.leave();
  FakeRoom.all[0]!.gate!.resolve();
  await Promise.all([entering, leaving]);
  assert.equal(lobby.getState().phase, "menu");
  assert.equal(FakeRoom.all[0]!.leaves, 1);
});

test("public rooms load, report errors, and ignore a stale response", async () => {
  reset();
  const first = deferred<{ rooms: never[] }>();
  let calls = 0;
  const lobby = lobbyWith({
    client: fakeClient({
      listPublicRooms: async () => {
        calls += 1;
        if (calls === 1) return first.promise;
        if (calls === 2) {
          return {
            rooms: [{ roomId: "a", playerCount: 1, maxPlayers: 4, joinable: true, modeLabel: "ranked" }],
          };
        }
        throw new Error("runtime does not advertise public_room_browser");
      },
    }),
  });
  assert.equal(lobby.getState().publicRooms.status, "idle");
  const stale = lobby.refreshPublicRooms();
  assert.equal(lobby.getState().publicRooms.status, "loading");
  await lobby.refreshPublicRooms();
  assert.equal(lobby.getState().publicRooms.status, "ready");
  assert.equal(lobby.getState().publicRooms.rooms[0]?.roomId, "a");

  first.resolve({ rooms: [] });
  await stale;
  assert.equal(lobby.getState().publicRooms.rooms.length, 1, "the older response does not overwrite the newer one");

  await lobby.refreshPublicRooms();
  assert.equal(lobby.getState().publicRooms.status, "error");
  assert.match(lobby.getState().publicRooms.error ?? "", /public_room_browser/);
  assert.equal(lobby.getState().publicRooms.rooms.length, 1, "the last good list stays visible");
});

const record = (rank: number, score: number) => ({
  playerId: `p${rank}`,
  displayName: `Player ${rank}`,
  score,
  subscore: 0,
  rank,
});

test("the leaderboard loads pages, appends more, and reports an empty board", async () => {
  reset();
  const requests: Array<{ id: string; options?: { limit?: number; cursor?: string } }> = [];
  const lobby = lobbyWith({
    leaderboardId: "high-scores",
    leaderboardPageSize: 2,
    client: fakeClient({
      listLeaderboard: async (id, options) => {
        requests.push({ id, options });
        if (!options?.cursor) {
          return { leaderboardId: id, records: [record(1, 30), record(2, 20)], nextCursor: "c1" };
        }
        return { leaderboardId: id, records: [record(3, 10)] };
      },
    }),
  });
  await lobby.loadLeaderboard();
  assert.equal(lobby.getState().leaderboard.status, "ready");
  assert.equal(lobby.getState().leaderboard.records.length, 2);
  assert.equal(lobby.getState().leaderboard.nextCursor, "c1");

  await lobby.loadMoreLeaderboard();
  assert.deepEqual(
    lobby.getState().leaderboard.records.map((entry) => entry.rank),
    [1, 2, 3],
  );
  assert.equal(lobby.getState().leaderboard.nextCursor, undefined);
  await lobby.loadMoreLeaderboard();
  assert.equal(requests.length, 2, "no request once there is no next page");
  assert.deepEqual(requests[0], { id: "high-scores", options: { limit: 2 } });
  assert.deepEqual(requests[1], { id: "high-scores", options: { limit: 2, cursor: "c1" } });

  const empty = lobbyWith({ leaderboardId: "high-scores" });
  await empty.loadLeaderboard();
  assert.equal(empty.getState().leaderboard.status, "ready");
  assert.equal(empty.getState().leaderboard.records.length, 0);
});

test("a failed leaderboard load keeps the rows already shown", async () => {
  reset();
  let fail = false;
  const lobby = lobbyWith({
    leaderboardId: "high-scores",
    client: fakeClient({
      listLeaderboard: async (id) => {
        if (fail) throw new Error("leaderboards are unsupported");
        return { leaderboardId: id, records: [record(1, 5)], nextCursor: "c" };
      },
    }),
  });
  await lobby.loadLeaderboard();
  fail = true;
  await lobby.loadMoreLeaderboard();
  assert.equal(lobby.getState().leaderboard.status, "error");
  assert.equal(lobby.getState().leaderboard.error, "leaderboards are unsupported");
  assert.equal(lobby.getState().leaderboard.records.length, 1);
});

test("submitScore uses the given name, falls back to a default, and refreshes a loaded board", async () => {
  reset();
  const submitted: Array<{ score: number; name?: string; subscore?: number }> = [];
  let loads = 0;
  const lobby = lobbyWith({
    leaderboardId: "high-scores",
    defaultDisplayName: "Guest",
    client: fakeClient({
      listLeaderboard: async (id) => {
        loads += 1;
        return { leaderboardId: id, records: [record(1, 99)] };
      },
      submitLeaderboardScore: async (_id, score, options) => {
        submitted.push({ score, name: options?.displayName, subscore: options?.subscore });
        return record(1, score);
      },
    }),
  });

  await lobby.submitScore(10);
  assert.equal(loads, 0, "an unopened board is not loaded by a submit");
  await lobby.loadLeaderboard();
  const named = await lobby.submitScore(25, { displayName: "  Ada  ", subscore: 3 });
  assert.equal(named?.score, 25);
  assert.equal(loads, 2, "a loaded board refreshes after a submit");
  assert.deepEqual(submitted, [
    { score: 10, name: "Guest", subscore: undefined },
    { score: 25, name: "Ada", subscore: 3 },
  ]);

  await lobby.submitScore(1, { displayName: "x".repeat(60) });
  assert.equal(submitted[2]?.name?.length, 32);
});

test("a failed submit reports the error and does not refresh", async () => {
  reset();
  const lobby = lobbyWith({
    leaderboardId: "high-scores",
    client: fakeClient({
      submitLeaderboardScore: async () => {
        throw new Error("rate limited");
      },
    }),
  });
  const result = await lobby.submitScore(5);
  assert.equal(result, undefined);
  assert.equal(lobby.getState().leaderboard.submitting, false);
  assert.equal(lobby.getState().leaderboard.submitError, "rate limited");
});

test("leaderboard calls need a leaderboard id and an integer score", async () => {
  reset();
  const lobby = lobbyWith();
  await assert.rejects(lobby.loadLeaderboard(), LobbyError);
  await assert.rejects(lobby.submitScore(1), LobbyError);

  const configured = lobbyWith({ leaderboardId: "high-scores" });
  await assert.rejects(configured.submitScore(1.5), LobbyError);
  await assert.rejects(configured.submitScore(1, { subscore: 0.5 }), LobbyError);
  assert.throws(() => lobbyWith({ leaderboardId: "High Scores" }), LobbyError);
  assert.throws(() => lobbyWith({ minPlayers: 0 }), LobbyError);
});

test("dispose stops updates and unsubscribes from the room without leaving", async () => {
  reset();
  const lobby = lobbyWith();
  const seen: string[] = [];
  lobby.subscribe((state) => seen.push(state.phase));
  await lobby.createPrivate();
  const count = seen.length;
  lobby.dispose();
  FakeRoom.all[0]!.setMembers(["me", "you"]);
  await lobby.createPrivate();
  assert.equal(seen.length, count);
  assert.equal(FakeRoom.all[0]!.leaves, 0);
  assert.equal(FakeRoom.all[0]!.listeners.size, 0);
});
