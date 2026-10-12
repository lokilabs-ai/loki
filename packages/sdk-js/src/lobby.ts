import type {
  LeaderboardListResult,
  LeaderboardRecord,
  ListPublicRoomsResult,
  PublicRoomSummary,
} from "../../protocol/src/index.js";
import type { ConnectionState, RoomMember } from "./synchronized-room.js";

/**
 * A framework-free lobby flow for a Loki game.
 *
 * The controller owns the order of operations that every game otherwise has
 * to hand-write: one fresh room object per match, `await leave()` before
 * another entry, a timeout on every creating / joining / searching step,
 * cancelling a matchmaking search, starting from the roster, a public room
 * list, and a per-game leaderboard. It draws nothing. The game reads
 * `getState()` and renders its own buttons, lists, and board in its own
 * theme.
 */

export type LobbyPhase =
  | "menu"
  | "creating"
  | "joining"
  | "searching"
  | "waiting"
  | "ready"
  | "leaving"
  | "error";

export type LobbyRoomSnapshot = {
  roomId: string;
  inviteCode: string;
  playerId: string;
  hostId: string;
  members: readonly RoomMember[];
  connection: ConnectionState;
  lastError?: Error;
};

/** The calls the lobby makes on a room. `SynchronizedRoom` and `RealtimeRoom` both satisfy it. */
export interface LobbyRoom {
  create(input?: {
    visibility?: "public" | "private" | "unlisted";
    modeLabel?: string;
  }): Promise<unknown>;
  join(input: { inviteCode: string }): Promise<unknown>;
  joinPublic(input: { roomId: string }): Promise<unknown>;
  matchmake(
    input: { minPlayers: number; maxPlayers: number; teamSize?: number },
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  leave(): Promise<void>;
  getSnapshot(): LobbyRoomSnapshot;
  subscribe(listener: (snapshot: LobbyRoomSnapshot) => void): () => void;
}

/** The client calls the lobby makes. `LokiClient` satisfies it. */
export interface LobbyClient {
  listPublicRooms(input?: { limit?: number }): Promise<ListPublicRoomsResult>;
  listLeaderboard(
    leaderboardId: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<LeaderboardListResult>;
  submitLeaderboardScore(
    leaderboardId: string,
    score: number,
    options?: { subscore?: number; displayName?: string },
  ): Promise<LeaderboardRecord>;
}

export type LobbyOptions<Room extends LobbyRoom> = {
  client: LobbyClient;
  /** Returns a brand new room. Called once per entry, never reused across matches. */
  makeRoom: () => Room;
  /** Fewest members before a match may start. Matchmaking uses its own `minPlayers`. */
  minPlayers: number;
  /** Required for the leaderboard calls. Lowercase letters, digits, and dashes. */
  leaderboardId?: string;
  /** Used when the game passes no display name. Default "Player". */
  defaultDisplayName?: string;
  /** Create / join step timeout. Default 15000. */
  timeoutMs?: number;
  /** Matchmaking search timeout. Default 60000. */
  searchTimeoutMs?: number;
  /** Public rooms requested per refresh. Default 50, max 50. */
  publicRoomLimit?: number;
  /** Leaderboard rows per page. Default 20, max 100. */
  leaderboardPageSize?: number;
};

export type LobbyRoomView = {
  roomId: string;
  inviteCode: string;
  playerId: string;
  hostId: string;
  members: RoomMember[];
  playerCount: number;
  minPlayers: number;
  /** True once the local player is in the roster. */
  seated: boolean;
  connection: ConnectionState;
  /** True only while `connection` is "connected". Lock match input whenever this is false. */
  canAct: boolean;
  /** Short plain-English text for a non-connected state. The game may show its own wording instead. */
  connectionNotice?: string;
};

export type ConnectionStatus = {
  canAct: boolean;
  notice?: string;
  /** True when the room cannot recover on its own: show a way back to the menu. */
  terminal: boolean;
};

/**
 * Turns a room's `connection` into what a game needs to draw: whether input is
 * allowed and a short notice. It draws nothing. Suspended, reconnecting, and
 * resynchronizing keep the last rendered state and wait for the SDK to recover.
 */
export function describeConnection(connection: ConnectionState): ConnectionStatus {
  switch (connection) {
    case "connected":
      return { canAct: true, terminal: false };
    case "suspended":
      return { canAct: false, notice: "Paused while the game is in the background.", terminal: false };
    case "reconnecting":
      return { canAct: false, notice: "Reconnecting…", terminal: false };
    case "resynchronizing":
      return { canAct: false, notice: "Catching up with the match…", terminal: false };
    case "joining":
      return { canAct: false, notice: "Joining…", terminal: false };
    case "leaving":
      return { canAct: false, notice: "Leaving…", terminal: false };
    case "leave_failed":
      return { canAct: false, notice: "Could not leave the room. Try again.", terminal: false };
    case "closed":
      return { canAct: false, notice: "The room has closed.", terminal: true };
    case "failed":
      return { canAct: false, notice: "The connection was lost.", terminal: true };
    case "idle":
      return { canAct: false, terminal: false };
  }
}

export type LobbyListStatus = "idle" | "loading" | "ready" | "error";

export type LobbyState = {
  phase: LobbyPhase;
  /** Set when `phase` is "error". Safe to show to the player. */
  error?: string;
  room?: LobbyRoomView;
  publicRooms: {
    status: LobbyListStatus;
    rooms: PublicRoomSummary[];
    error?: string;
  };
  leaderboard: {
    status: LobbyListStatus;
    records: LeaderboardRecord[];
    nextCursor?: string;
    error?: string;
    submitting: boolean;
    submitError?: string;
  };
};

export class LobbyError extends Error {
  constructor(
    readonly code: "invalid_input" | "leaderboard_not_configured",
    message: string,
  ) {
    super(message);
    this.name = "LobbyError";
  }
}

export interface Lobby<Room extends LobbyRoom> {
  getState(): LobbyState;
  subscribe(listener: (state: LobbyState) => void): () => void;
  /** The current room, for `dispatch()` and the realtime calls. Undefined at the menu. */
  getRoom(): Room | undefined;
  createPrivate(): Promise<void>;
  createPublic(input?: { modeLabel?: string }): Promise<void>;
  joinWithCode(inviteCode: string): Promise<void>;
  joinPublic(roomId: string): Promise<void>;
  matchmake(input: { minPlayers: number; maxPlayers: number; teamSize?: number }): Promise<void>;
  /** Stops a search. The lobby returns to the menu once the search settles. */
  cancelSearch(): Promise<void>;
  /** Leaves the room (if any) and returns to the menu. Also clears an error. Safe to call again after a failed leave. */
  leave(): Promise<void>;
  refreshPublicRooms(): Promise<void>;
  loadLeaderboard(): Promise<void>;
  loadMoreLeaderboard(): Promise<void>;
  submitScore(
    score: number,
    options?: { subscore?: number; displayName?: string },
  ): Promise<LeaderboardRecord | undefined>;
  /** Unsubscribes from the room. Does not leave it. */
  dispose(): void;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 60_000;
const LEADERBOARD_ID = /^[a-z0-9-]{1,64}$/;
const MAX_DISPLAY_NAME = 32;

const messageOf = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "something went wrong";
};

const clamp = (value: number | undefined, fallback: number, max: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
};

type EntryKind = "creating" | "joining" | "searching";

export function createLobby<Room extends LobbyRoom>(options: LobbyOptions<Room>): Lobby<Room> {
  if (!Number.isInteger(options.minPlayers) || options.minPlayers < 1) {
    throw new LobbyError("invalid_input", "minPlayers must be a positive integer");
  }
  if (options.leaderboardId !== undefined && !LEADERBOARD_ID.test(options.leaderboardId)) {
    throw new LobbyError(
      "invalid_input",
      "leaderboardId must use lowercase letters, digits, and dashes (1-64 characters)",
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const searchTimeoutMs = options.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
  const publicRoomLimit = clamp(options.publicRoomLimit, 50, 50);
  const pageSize = clamp(options.leaderboardPageSize, 20, 100);
  const defaultName = (options.defaultDisplayName ?? "Player").trim().slice(0, MAX_DISPLAY_NAME) || "Player";

  const listeners = new Set<(state: LobbyState) => void>();
  let state: LobbyState = {
    phase: "menu",
    publicRooms: { status: "idle", rooms: [] },
    leaderboard: { status: "idle", records: [], submitting: false },
  };

  let room: Room | undefined;
  let unsubscribeRoom: (() => void) | undefined;
  let requiredPlayers = options.minPlayers;
  // Bumped whenever an entry is started, cancelled, or left, so a promise that
  // settles late can tell it no longer owns the lobby.
  let generation = 0;
  let searchAbort: AbortController | undefined;
  let entrySettled: Promise<void> | undefined;
  // A room abandoned mid-entry (cancel, timeout, leave) is released exactly
  // once, after its in-flight call settles, so no seat is left held.
  const released = new Map<Room, Promise<void>>();
  const release = (target: Room, settled: Promise<void> | undefined): Promise<void> => {
    const existing = released.get(target);
    if (existing) return existing;
    const done = (settled ?? Promise.resolve()).then(() => target.leave().catch(() => undefined));
    released.set(target, done);
    return done;
  };
  let publicRequest = 0;
  let boardRequest = 0;
  let disposed = false;

  const emit = (): void => {
    if (disposed) return;
    for (const listener of [...listeners]) listener(state);
  };
  const update = (patch: Partial<LobbyState>): void => {
    state = { ...state, ...patch };
    emit();
  };

  const viewOf = (snapshot: LobbyRoomSnapshot): LobbyRoomView => {
    const members = snapshot.members.map((member) => ({ ...member }));
    const status = describeConnection(snapshot.connection);
    return {
      roomId: snapshot.roomId,
      inviteCode: snapshot.inviteCode,
      playerId: snapshot.playerId,
      hostId: snapshot.hostId,
      members,
      playerCount: members.length,
      minPlayers: requiredPlayers,
      seated: members.some((member) => member.playerId === snapshot.playerId),
      connection: snapshot.connection,
      canAct: status.canAct,
      ...(status.notice ? { connectionNotice: status.notice } : {}),
    };
  };

  // Starting is decided from the roster, never from one flag: enough members
  // and the local player seated. A brief reconnect does not undo "ready"; the
  // game reads `room.connection` to show a reconnecting message.
  const phaseFor = (view: LobbyRoomView): "waiting" | "ready" =>
    view.playerCount >= view.minPlayers &&
    view.seated &&
    view.connection !== "idle" &&
    view.connection !== "joining" &&
    view.connection !== "leaving"
      ? "ready"
      : "waiting";

  const detachRoom = (): void => {
    unsubscribeRoom?.();
    unsubscribeRoom = undefined;
  };

  const attachRoom = (next: Room): void => {
    detachRoom();
    unsubscribeRoom = next.subscribe((snapshot) => {
      if (next !== room) return;
      if (state.phase !== "waiting" && state.phase !== "ready") return;
      if (snapshot.connection === "closed" || snapshot.connection === "failed") {
        update({
          phase: "error",
          error: snapshot.lastError ? messageOf(snapshot.lastError) : "the room connection was lost",
          room: viewOf(snapshot),
        });
        return;
      }
      const view = viewOf(snapshot);
      update({ phase: phaseFor(view), room: view, error: undefined });
    });
  };

  const withTimeout = <T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error("timed out"));
      }, ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });

  // Leave the current room and wait for it. A failed leave keeps the room so a
  // later call can retry; the lobby never starts another entry over it.
  const leaveCurrent = async (): Promise<boolean> => {
    const current = room;
    if (!current) return true;
    const connection = current.getSnapshot().connection;
    if (connection === "idle") {
      detachRoom();
      room = undefined;
      return true;
    }
    update({ phase: "leaving", error: undefined });
    try {
      await current.leave();
    } catch (error) {
      update({
        phase: "error",
        error: `could not leave the room: ${messageOf(error)}`,
        room: viewOf(current.getSnapshot()),
      });
      return false;
    }
    if (room === current) {
      detachRoom();
      room = undefined;
    }
    return true;
  };

  const busy = (): boolean =>
    state.phase === "creating" ||
    state.phase === "joining" ||
    state.phase === "searching" ||
    state.phase === "leaving";

  const enter = async (
    kind: EntryKind,
    minPlayers: number,
    run: (target: Room, signal?: AbortSignal) => Promise<unknown>,
  ): Promise<void> => {
    if (disposed || busy()) return;
    if (!(await leaveCurrent())) return;

    generation += 1;
    const token = generation;
    requiredPlayers = minPlayers;
    const target = options.makeRoom();
    room = target;
    attachRoom(target);
    const abort = kind === "searching" ? new AbortController() : undefined;
    searchAbort = abort;
    update({ phase: kind, error: undefined, room: undefined });

    const attempt = run(target, abort?.signal);
    const settled = attempt.then(
      () => undefined,
      () => undefined,
    );
    entrySettled = settled;

    try {
      await withTimeout(attempt, kind === "searching" ? searchTimeoutMs : timeoutMs, () => abort?.abort());
    } catch (error) {
      if (token !== generation) {
        // Cancelled or replaced. If the entry still landed, give the seat back.
        void release(target, settled);
        return;
      }
      generation += 1;
      searchAbort = undefined;
      // The attempt may still land after a timeout, so release it too.
      void release(target, settled);
      detachRoom();
      room = undefined;
      update({ phase: "error", error: messageOf(error), room: undefined });
      return;
    }
    if (token !== generation) {
      void release(target, settled);
      return;
    }
    searchAbort = undefined;
    const view = viewOf(target.getSnapshot());
    update({ phase: phaseFor(view), room: view, error: undefined });
  };

  const listPublic = async (): Promise<void> => {
    const request = (publicRequest += 1);
    update({ publicRooms: { ...state.publicRooms, status: "loading", error: undefined } });
    try {
      const result = await options.client.listPublicRooms({ limit: publicRoomLimit });
      if (request !== publicRequest) return;
      update({ publicRooms: { status: "ready", rooms: [...result.rooms] } });
    } catch (error) {
      if (request !== publicRequest) return;
      update({
        publicRooms: { status: "error", rooms: state.publicRooms.rooms, error: messageOf(error) },
      });
    }
  };

  const requireLeaderboard = (): string => {
    if (!options.leaderboardId) {
      throw new LobbyError(
        "leaderboard_not_configured",
        "pass leaderboardId to createLobby to use the leaderboard",
      );
    }
    return options.leaderboardId;
  };

  const fetchBoard = async (cursor?: string): Promise<void> => {
    const id = requireLeaderboard();
    const request = (boardRequest += 1);
    update({
      leaderboard: {
        ...state.leaderboard,
        status: "loading",
        error: undefined,
        ...(cursor ? {} : { records: [], nextCursor: undefined }),
      },
    });
    try {
      const result = await options.client.listLeaderboard(id, {
        limit: pageSize,
        ...(cursor ? { cursor } : {}),
      });
      if (request !== boardRequest) return;
      update({
        leaderboard: {
          ...state.leaderboard,
          status: "ready",
          records: cursor ? [...state.leaderboard.records, ...result.records] : [...result.records],
          nextCursor: result.nextCursor,
          error: undefined,
        },
      });
    } catch (error) {
      if (request !== boardRequest) return;
      update({ leaderboard: { ...state.leaderboard, status: "error", error: messageOf(error) } });
    }
  };

  const cancelSearch = async (): Promise<void> => {
    if (state.phase !== "searching") return;
    generation += 1;
    const current = room;
    const pending = entrySettled;
    searchAbort?.abort();
    searchAbort = undefined;
    detachRoom();
    room = undefined;
    // Wait for the search to settle and leave a room it may have landed in,
    // so the next entry never overlaps with this one.
    if (current) await release(current, pending);
    update({ phase: "menu", error: undefined, room: undefined });
  };

  const leave = async (): Promise<void> => {
    if (disposed) return;
    if (state.phase === "searching") {
      await cancelSearch();
      return;
    }
    if (state.phase === "leaving") return;
    if (state.phase === "creating" || state.phase === "joining") {
      generation += 1;
      const current = room;
      const pending = entrySettled;
      detachRoom();
      room = undefined;
      if (current) await release(current, pending);
      update({ phase: "menu", error: undefined, room: undefined });
      return;
    }
    if (!(await leaveCurrent())) return;
    update({ phase: "menu", error: undefined, room: undefined });
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getRoom: () => room,

    createPrivate: () =>
      enter("creating", options.minPlayers, (target) => target.create({ visibility: "private" })),

    createPublic: (input) =>
      enter("creating", options.minPlayers, (target) =>
        target.create({
          visibility: "public",
          ...(input?.modeLabel ? { modeLabel: input.modeLabel } : {}),
        }),
      ),

    async joinWithCode(inviteCode) {
      const code = inviteCode.trim();
      if (!code) {
        if (busy() || disposed) return;
        update({ phase: "error", error: "enter an invite code" });
        return;
      }
      await enter("joining", options.minPlayers, (target) => target.join({ inviteCode: code }));
    },

    joinPublic: (roomId) =>
      enter("joining", options.minPlayers, (target) => target.joinPublic({ roomId })),

    async matchmake(input) {
      if (
        !Number.isInteger(input.minPlayers) ||
        !Number.isInteger(input.maxPlayers) ||
        input.minPlayers < 1 ||
        input.maxPlayers < input.minPlayers
      ) {
        throw new LobbyError("invalid_input", "matchmake needs minPlayers <= maxPlayers, both positive integers");
      }
      await enter("searching", input.minPlayers, (target, signal) =>
        target.matchmake(input, signal ? { signal } : undefined),
      );
    },

    cancelSearch,
    leave,

    refreshPublicRooms: listPublic,

    loadLeaderboard: () => fetchBoard(),

    async loadMoreLeaderboard() {
      requireLeaderboard();
      const cursor = state.leaderboard.nextCursor;
      if (!cursor || state.leaderboard.status === "loading") return;
      await fetchBoard(cursor);
    },

    async submitScore(score, scoreOptions = {}) {
      const id = requireLeaderboard();
      if (!Number.isInteger(score)) {
        throw new LobbyError("invalid_input", "score must be an integer");
      }
      if (scoreOptions.subscore !== undefined && !Number.isInteger(scoreOptions.subscore)) {
        throw new LobbyError("invalid_input", "subscore must be an integer");
      }
      if (state.leaderboard.submitting) return undefined;
      const displayName =
        (scoreOptions.displayName ?? "").trim().slice(0, MAX_DISPLAY_NAME) || defaultName;
      update({ leaderboard: { ...state.leaderboard, submitting: true, submitError: undefined } });
      try {
        const record = await options.client.submitLeaderboardScore(id, score, {
          ...(scoreOptions.subscore !== undefined ? { subscore: scoreOptions.subscore } : {}),
          displayName,
        });
        update({ leaderboard: { ...state.leaderboard, submitting: false } });
        if (state.leaderboard.status !== "idle") await fetchBoard();
        return record;
      } catch (error) {
        update({
          leaderboard: { ...state.leaderboard, submitting: false, submitError: messageOf(error) },
        });
        return undefined;
      }
    },

    dispose() {
      disposed = true;
      detachRoom();
      listeners.clear();
    },
  };
}
