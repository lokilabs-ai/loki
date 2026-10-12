import { GameManifestSchema } from "../../protocol/src/index.js";

export const lokiResources = [
  {
    uri: "loki://docs/integration",
    name: "Loki integration guide",
    mimeType: "text/markdown",
    text: [
      "# Loki integration",
      "Use @lokiplay/sdk and a host-authoritative room.",
      "Install @lokiplay/sdk for types and local development and import it as usual, but leave it external in the production build only (Vite: build.rollupOptions.external: [\"@lokiplay/sdk\"]). In production Loki serves the SDK from the game host at /loki/sdk.js and maps the import to it, so production may run a newer compatible SDK than the pinned package. Ship an ES module entry, do not import the SDK from a Web Worker, do not register a game service worker that intercepts or caches /loki/sdk.js, and run lokiplay preview on the finished build before lokiplay ship.",
      "Create rooms with createRoom() and join with joinRoom({ inviteCode }). create() stays invite-only unless the game explicitly passes { visibility: \"public\" }. Every game offers both: a private room joined by invite code, and a public room that appears in a public room list. Do not make every room public. Loki's SDK does not add a public lobby screen; the game agent must build the room browser and all loading, empty, joining, full-room, waiting, readiness, and error states. The Loki overlay does not list, create, or join public rooms.",
      "Run the room flow through the SDK's lobby controller and build every screen yourself. Call client.createLobby({ makeRoom, minPlayers, leaderboardId }), where makeRoom returns a fresh createSynchronizedRoom() or createRealtimeRoom() for each match. The controller draws nothing: read lobby.getState() (and lobby.subscribe()) and render it. phase is menu, creating, joining, searching, waiting, ready, leaving, or error; state.room has the invite code and the roster count against minPlayers; state.publicRooms and state.leaderboard each carry their own loading, ready, and error status. Actions are createPrivate(), createPublic({ modeLabel }), joinWithCode(code), joinPublic(roomId), refreshPublicRooms(), matchmake({ minPlayers, maxPlayers, teamSize }), cancelSearch(), leave(), loadLeaderboard(), loadMoreLeaderboard(), and submitScore(score, { displayName }). Use lobby.getRoom() for dispatch() and the realtime calls. A call made while another entry is in flight is ignored. Do not hand-write create/join/leave sequencing, timeouts, or match start logic around it.",
      "Installing the SDK, or using the lobby controller, does not add any screen, and the Loki overlay never draws them. Build these screens in the game's own theme, with its art direction, fonts, colors, and controls, not an unstyled default, and keep them usable on touch and on desktop: create room, join with an invite code, copy invite, and start when ready; a Create private room control and a Create public room control, a public room list (refreshPublicRooms()), and join from that list; a Match control (matchmake()) with confirmed player/team settings plus searching, a cancel control (cancelSearch()), timeout, waiting, and error states; a per-game Leaderboard with display-name collection or a sensible fallback plus loading, empty, pagination (loadMoreLeaderboard()), submission, and error states; and loading, waiting, and error states on every screen, showing state.error. Public rooms, Match, and the Leaderboard are required in every game; do not ask the creator whether to build them. Player count, teams, and scoring stay creator decisions; if the game has no numeric result, ask the creator once what to record instead of inventing a scoring rule. Leaderboards are per-game/project and available to guest sessions without a creator account; client-submitted scores are not an anti-cheat boundary.",
      "Inspect the game to establish its multiplayer profile. Do not infer player counts, teams, or simulation type from the game's name or genre. If a material field is ambiguous, stop and ask the creator. Do not invent new game.json fields.",
      "After confirming each mode's profile, choose createSynchronizedRoom for turn-based or event-driven state, or createRealtimeRoom for continuous realtime. Host is more suitable for turn-based and event-driven games. Server is more suitable for continuous realtime games. Do not choose by genre or animation smoothness. A server step's next state must depend only on the previous state and that tick's inputs.",
      "createSynchronizedRoom: keep synchronized state compact and JSON-compatible; reducers must be synchronous, deterministic, and free of rendering, timers, networking, or other I/O.",
      "createRealtimeRoom: integrate the game's existing simulation through its predict/interpolate/extrapolate/blendCorrection/shouldCorrect/composeRenderState callbacks instead of a parallel input queue, RTT estimator, snapshot pacer, stale-round rejection, input ledger, interpolation buffer, or reconnect netcode; the SDK owns per-submission in-flight accounting and setInput() network pacing too. For multi-entity games, use getRenderStates()/composeRenderState (or the createEntityCompositor/createLocalPrediction helpers, preferring the bulk setEntities over setEntity for many entities) to render each entity from the stream that fits it (predicted for local, interpolated/latestAuthoritative for remotes) instead of predicting every entity, which diverges after collisions. publishSnapshot() already coalesces multiple same-turn calls to a single send; do not build a separate coalescing layer. Use sendEffect()/onConfirmedEffect() to confirm authoritative events (e.g. collisions) with a stable id instead of a custom event-confirmation channel, so speculative local particles/audio can be deduped against the confirmed outcome. Use createHostedLokiClient() to own the hosted-shell loki:init/loki:session handshake at page boot instead of hand-writing it. Keep one game-owned render loop, keep authoritative snapshots compact and self-contained. snapshotHz (default 30, cap 100) is a ceiling, not a delivery guarantee: start conservative with adaptiveRate: true and a low initialSnapshotHz, or use calibrateRealtimeRoom() against a real two-player pair (fixed snapshotHz per candidate) to pick the highest delivered rate without a transport/hold/ack cliff and write only that RealtimeProfile into createRealtimeRoom(); game.json tickRate is a separate Nakama room-loop setting and must not be copied from snapshotHz. Report the selected rates plus observed diagnostics (including acceptance/rejection ratios, held authoritative frames, and onDiagnosticWarning events) as evidence. Loki does not supply physics, collision, rendering optimization, or competitive integrity for realtime rooms.",
      "Let the SDK own page lifecycle, socket replacement, retries, snapshots, and pending-action replay. Keep the same client and room while interrupted. Never leave, close, disconnect, reload, or replace a room because of visibility, page, focus, or network lifecycle events.",
      "Dispatch only while connected. During suspended, reconnecting, or resynchronizing, lock authoritative input, preserve rendered state, show a temporary reconnecting message, and wait for an authoritative snapshot. Do not assume host authority survives reconnect.",
      "For a synchronized room, every control that commits a match action calls dispatch() while connection is connected. Decide whether the player can act from the latest snapshot, and use that same check for the control and for the handler. Draw the committed result from the snapshot that comes back. Aim, hover, and animation stay local. The same control works for the host and for every other member. If the player cannot act, or dispatch() rejects or throws, show that on the control. Do not ignore the input, and do not apply the committed result on the acting client before the snapshot arrives.",
      "Do not repeat unresolved actions under new IDs. Treat indeterminate confirmation as an unknown outcome, room_closed as terminal, and leave_failed as requiring resolution before another room.",
      "Keep the same client and synchronized room while a match is interrupted, but between matches await leave() on the old room, stop listening to it, and create a fresh createSynchronizedRoom() for the next match instead of reusing the old room object (the lobby controller does this when makeRoom returns a new room).",
      "Do not put credentials, access tokens, deployment secrets, private keys, or environment-secret values in code, game.json, logs, commits, or reports, and never ask the user to paste a token or deployment credential. Before any browser action that needs login, OAuth, permissions, external account access, or a deployment confirmation, pause and ask the user for explicit approval.",
      "If lokiplay ship or connect reports that the game is inactive, stop and tell the user to press Reactivate for this project in the Loki dashboard, then ship again. Do not create another project to get around it.",
      "The upload is the finished browser build only, within 25 MiB compressed, 100 MiB uncompressed, and 1000 files. If lokiplay init created game.json, its multiplayer values (host, maxPlayers 8, tickRate 30) are placeholders, not a confirmed profile; replace them with the confirmed values for this game.",
      "The lobby controller already does the next three rules. Follow them yourself only for a room the game manages outside the controller. Starting another match from the menu: await leave() to completion before create(), join(), joinPublic(), or matchmake(); skip it only when connection is idle. Do not treat closed or failed as already left while a room id is still held; call leave() and retry after leave_failed. Reset game-local match state whenever the room id changes. Every Creating, Joining, and Searching screen needs a timeout, an error message, and a way back to the menu.",
      "Start the match from the roster, not from one flag: begin once the minimum number of members are present and the local player has a seat. Do not gate the start on membership === \"ready\" alone; it can read synchronizing briefly while the roster is restored. While fewer members are present, show the invite code with a player count such as 1 / 2.",
      "Every game shows both a Create private room control and a Create public room control (createPrivate() / createPublic(), or create({ visibility: \"public\" }) on a room you manage yourself), and a public room list built on refreshPublicRooms() (or listPublicRooms() and joinPublic({ roomId })) with loading, empty, joining, full, waiting, and error states.",
      "Use a mobile viewport with viewport-fit=cover without globally disabling zoom. Fill 100dvh with a 100vh fallback, account for safe areas, recalculate container layout on viewport changes, and avoid document scrolling during play.",
      "Use Pointer Events across touch and desktop input, scoped touch-action, pointer capture and cancellation handling, 44x44 CSS-pixel primary targets, and no hover-only controls.",
      "For canvas games, separate CSS and backing size, cap devicePixelRatio reasonably, and resize and redraw without replacing the canvas. Use one controlled requestAnimationFrame loop and pause or throttle rendering while hidden without leaving the room.",
      "Report mobile Safari and Android Chrome coverage without claiming real-device testing unless it actually occurred.",
      "Production multiplayer requires a Loki-hosted build.",
      "Never include backend source, secrets, localhost URLs, or creator ad scripts.",
    ].join("\n\n"),
  },
  {
    uri: "loki://schemas/game-manifest",
    name: "game.json schema",
    mimeType: "application/json",
    text: JSON.stringify({
      schemaVersion: 1,
      authority: "host",
      maxPlayers: "1..16",
      tickRate: "1..30",
    }),
  },
] as const;

export const lokiTools = [
  {
    name: "create_project",
    description: "Create a Loki project in an authenticated organization.",
  },
  {
    name: "validate_manifest",
    description: "Validate a Loki game.json manifest before deployment.",
  },
  {
    name: "create_deployment_credential",
    description: "Issue a short-lived one-use credential for a project upload.",
  },
  {
    name: "deployment_status",
    description: "Read deployment compatibility and activation status.",
  },
  {
    name: "integration_requirements",
    description: "Return exact production package names and multiplayer constraints.",
  },
  {
    name: "diagnose_multiplayer",
    description: "Diagnose common obsolete or unsafe multiplayer integration patterns.",
  },
] as const;

export interface LokiMcpApi {
  createProject(input: {
    organizationId: string;
    name: string;
    slug: string;
  }): Promise<unknown>;
  createDeploymentCredential(projectId: string): Promise<unknown>;
  deploymentStatus(projectId: string, deploymentId: string): Promise<unknown>;
}

export async function callLokiTool(
  api: LokiMcpApi,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (name === "create_project") {
    if (
      typeof input.organizationId !== "string" ||
      typeof input.name !== "string" ||
      typeof input.slug !== "string"
    ) {
      throw new Error("organizationId, name, and slug are required");
    }
    return api.createProject({
      organizationId: input.organizationId,
      name: input.name,
      slug: input.slug,
    });
  }
  if (name === "validate_manifest") {
    const manifest = GameManifestSchema.parse(input.manifest);
    return { valid: true, manifest };
  }
  if (name === "create_deployment_credential") {
    if (typeof input.projectId !== "string") {
      throw new Error("projectId is required");
    }
    return api.createDeploymentCredential(input.projectId);
  }
  if (name === "deployment_status") {
    if (
      typeof input.projectId !== "string" ||
      typeof input.deploymentId !== "string"
    ) {
      throw new Error("projectId and deploymentId are required");
    }
    return api.deploymentStatus(input.projectId, input.deploymentId);
  }
  if (name === "integration_requirements") {
    return {
      packages: ["@lokiplay/sdk@0.5.5", "@lokiplay/ui-web@0.5.5"],
      command: "npm install @lokiplay/sdk@0.5.5 @lokiplay/ui-web@0.5.5",
      apiOrigin: "https://api.lokiplay.cc",
      authority: "host",
      rankedIntegrity: false,
      synchronizedRooms: true,
      realtimeRooms: true,
      guidance:
        "After confirming each mode's profile, choose createSynchronizedRoom for turn-based or event-driven state, or createRealtimeRoom for continuous realtime (snapshotHz is a ceiling, default 30, cap 100; start conservative with adaptiveRate: true or write only the RealtimeProfile from calibrateRealtimeRoom() into createRealtimeRoom(); do not copy snapshotHz into game.json tickRate). Host is more suitable for turn-based and event-driven games. Server is more suitable for continuous realtime games. Do not choose by genre or animation smoothness. For createRealtimeRoom, integrate the game's existing simulation through its callbacks rather than a parallel input queue, RTT estimator, snapshot pacer, or reconnect netcode, keep one game-owned render loop, and report selected rates and diagnostics as evidence; Loki does not supply physics, collision, rendering optimization, or competitive integrity. Installing the SDK does not add any screen. Run the room flow through client.createLobby({ makeRoom, minPlayers, leaderboardId }) and build every screen yourself, in the game's own theme: create room, join with an invite code, copy invite, start when ready; a Create private room control and a Create public room control with a public room list; a Match control calling matchmake() with searching/cancel/timeout/waiting/error states; and a per-game Leaderboard with display-name/loading/empty/pagination/submission/error states. Public rooms, Match, and the Leaderboard are required in every game; do not ask the creator whether to build them. Scoring stays a creator decision and client-submitted scores are not an anti-cheat boundary; do not make every room public. Loki's SDK does not add a public lobby screen, and the Loki overlay does not list, create, or join public rooms. Inspect the game to establish its multiplayer profile; do not infer player counts, teams, or simulation type from name or genre, and stop to ask the creator when a material field is ambiguous. Do not invent new game.json fields. Let Loki own lifecycle reconnect and pending-action replay; never leave or replace a room on browser visibility, page, focus, or network events. Dispatch only while connected and preserve authoritative state while suspended, reconnecting, or resynchronizing. Use responsive safe-area-aware viewport sizing, Pointer Events for touch and desktop, and bounded canvas resolution and rendering. Low-level sendAction and sendHostState remain supported. Native clients cannot join realtime-mode rooms until a later parity release.",
    };
  }
  if (name === "diagnose_multiplayer") {
    const sources = Array.isArray(input.sources)
      ? input.sources.filter((source): source is string => typeof source === "string")
      : [];
    const joined = sources.join("\n");
    const findings: Array<{ code: string; message: string }> = [];
    if (/socket\.io-client|\/socket\.io\b/i.test(joined)) {
      findings.push({
        code: "OBSOLETE_SOCKET_IO",
        message: "Replace the creator backend with @lokiplay/sdk FirstPartyTransport.",
      });
    }
    if (/@heroiclabs\/nakama-js|\b7350\b/i.test(joined)) {
      findings.push({
        code: "DIRECT_NAKAMA",
        message: "Game code must use @lokiplay/sdk and must not depend on Nakama types.",
      });
    }
    if (/localhost|127\.0\.0\.1/i.test(joined)) {
      findings.push({
        code: "LOCAL_ENDPOINT",
        message: "Use https://api.lokiplay.cc or an explicit non-production override.",
      });
    }
    if (/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i.test(joined) || /\son[a-z]+\s*=/i.test(joined)) {
      findings.push({
        code: "INLINE_SCRIPT",
        message:
          "Move JavaScript into a same-origin .js file. Inline <script> tags and event handlers are blocked by Loki CSP.",
      });
    }
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(joined)) {
      findings.push({
        code: "REMOTE_FONT",
        message: "Self-host font files. Google Fonts and other remote stylesheets are blocked by Loki CSP.",
      });
    }
    if (/<form\b/i.test(joined)) {
      findings.push({
        code: "SANDBOX_FORM",
        message:
          "The Loki iframe does not allow form submission. Use <button type=\"button\"> and JavaScript click handlers.",
      });
    }
    if (!/@lokiplay\/sdk|FirstPartyTransport|LokiClient/.test(joined)) {
      findings.push({
        code: "SDK_NOT_DETECTED",
        message: "Install and initialize @lokiplay/sdk@0.5.5.",
      });
    }
    if (
      /sendHostState|sendAction/.test(joined) &&
      !/createSynchronizedRoom/.test(joined)
    ) {
      findings.push({
        code: "MANUAL_SYNCHRONIZATION",
        message:
          "Prefer createSynchronizedRoom so Loki owns versions, retries, and membership.",
      });
    }
    return { ok: findings.length === 0, findings };
  }
  throw new Error(`unknown Loki tool: ${name}`);
}
