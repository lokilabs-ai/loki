import assert from "node:assert/strict";
import test from "node:test";
import { MASTER_TEST_ACCOUNT_EMAIL, isMasterTestAccount } from "../apps/api/src/master-account.js";
import { PlatformService } from "../apps/api/src/platform.js";
import {
  NAKAMA_ROOM_QUOTA_CAP,
  PLANS,
  applyPlanToTenantConfig,
  entitledPlan,
  roomQuotaForPlan,
} from "../apps/api/src/plans.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function hostManifest(maxPlayers: number) {
  return {
    multiplayer: { enabled: true as const, authority: "host" as const, maxPlayers },
  };
}

function serverManifest(maxPlayers: number) {
  return {
    multiplayer: { enabled: true as const, authority: "server" as const, maxPlayers },
  };
}

function createGames(
  platform: PlatformService,
  creator: ReturnType<PlatformService["registerCreator"]>,
  count: number,
  prefix: string,
) {
  const projects = [];
  for (let index = 0; index < count; index += 1) {
    projects.push(
      platform.createProject(creator.account.id, creator.organization.id, {
        name: `${prefix} ${index}`,
        slug: `${prefix}-${index}`,
      }),
    );
  }
  return projects;
}

function activateAll(
  platform: PlatformService,
  accountId: string,
  projects: Array<{ id: string }>,
) {
  for (const project of projects) {
    platform.transitionProject(accountId, project.id, "private");
  }
}

test("the plan table holds the published limits for every plan", () => {
  assert.deepEqual(PLANS.free, {
    games: 2,
    playLinks: 1,
    storedBytes: 100 * MIB,
    simultaneousRooms: 2,
    maxPlayersPerRoom: 4,
    serverAuthority: false,
    publicCatalog: false,
  });
  assert.deepEqual(PLANS.loki, {
    games: 20,
    playLinks: 20,
    storedBytes: 500 * MIB,
    simultaneousRooms: null,
    maxPlayersPerRoom: 8,
    serverAuthority: true,
    publicCatalog: true,
  });
  assert.deepEqual(PLANS.pro, {
    games: null,
    playLinks: null,
    storedBytes: 2 * GIB,
    simultaneousRooms: null,
    maxPlayersPerRoom: 16,
    serverAuthority: true,
    publicCatalog: true,
  });
  assert.equal(roomQuotaForPlan("free"), 2);
  assert.equal(roomQuotaForPlan("loki"), NAKAMA_ROOM_QUOTA_CAP);
  assert.equal(roomQuotaForPlan("pro"), NAKAMA_ROOM_QUOTA_CAP);
});

test("a new account starts on Free with a stored-game cap of two and one active game", () => {
  const platform = new PlatformService();
  const creator = platform.registerCreator("free@example.test", "Free");
  assert.equal(creator.account.plan, "free");
  const [first, second] = createGames(platform, creator, 2, "free");
  assert.throws(
    () => createGames(platform, creator, 1, "third"),
    /Free allows 2 stored games/,
  );
  platform.transitionProject(creator.account.id, first!.id, "private");
  assert.throws(
    () => platform.transitionProject(creator.account.id, second!.id, "private"),
    /Free allows 1 active game\. Deactivate free 0 first\./,
  );
  platform.transitionProject(creator.account.id, first!.id, "inactive");
  platform.transitionProject(creator.account.id, second!.id, "private");
});

test("Free rooms hold four players, run on the host, and use two simultaneous rooms", () => {
  const platform = new PlatformService();
  const creator = platform.registerCreator("free@example.test", "Free");
  const [project] = createGames(platform, creator, 1, "free");
  const limits = platform.projectRuntimeLimits(project!.id);
  assert.equal(limits.plan, "free");
  assert.equal(limits.maxPlayersPerRoom, 4);
  assert.equal(limits.simultaneousRooms, 2);
  assert.equal(limits.serverAuthority, false);
  assert.equal(limits.storedBytes, 100 * MIB);
  platform.assertManifestAllowed(project!.id, hostManifest(4));
  assert.throws(
    () => platform.assertManifestAllowed(project!.id, hostManifest(5)),
    /this plan allows 4 players per room/,
  );
  assert.throws(
    () => platform.assertManifestAllowed(project!.id, serverManifest(2)),
    /server authority requires Loki or Loki Pro/,
  );
  const tenant = applyPlanToTenantConfig(
    { maxPlayers: 16, authority: "host" as const, concurrentRoomQuota: 100 },
    "free",
  );
  assert.equal(tenant.maxPlayers, 4);
  assert.equal(tenant.concurrentRoomQuota, 2);
});

test("Loki stores twenty games, activates twenty, and rooms hold eight players", () => {
  const platform = new PlatformService();
  const creator = platform.registerCreator("loki@example.test", "Loki");
  platform.assignPlan(creator.account.id, "loki");
  const games = createGames(platform, creator, 20, "loki");
  assert.throws(
    () => createGames(platform, creator, 1, "extra"),
    /This plan allows 20 stored games/,
  );
  activateAll(platform, creator.account.id, games);
  const limits = platform.projectRuntimeLimits(games[0]!.id);
  assert.equal(limits.plan, "loki");
  assert.equal(limits.maxPlayersPerRoom, 8);
  assert.equal(limits.simultaneousRooms, NAKAMA_ROOM_QUOTA_CAP);
  assert.equal(limits.serverAuthority, true);
  assert.equal(limits.storedBytes, 500 * MIB);
  platform.assertManifestAllowed(games[0]!.id, hostManifest(8));
  platform.assertManifestAllowed(games[0]!.id, serverManifest(8));
  assert.throws(
    () => platform.assertManifestAllowed(games[0]!.id, hostManifest(9)),
    /this plan allows 8 players per room/,
  );
});

test("Loki keeps the twenty-game cap after a game is deleted and replaced", () => {
  const platform = new PlatformService();
  const creator = platform.registerCreator("loki@example.test", "Loki");
  platform.assignPlan(creator.account.id, "loki");
  const games = createGames(platform, creator, 20, "loki");
  activateAll(platform, creator.account.id, games);
  platform.deleteProject(creator.account.id, games[0]!.id);
  const [replacement] = createGames(platform, creator, 1, "again");
  platform.transitionProject(creator.account.id, replacement!.id, "private");
  assert.throws(
    () => createGames(platform, creator, 1, "over"),
    /This plan allows 20 stored games/,
  );
});

test("Loki Pro has no game cap and rooms hold sixteen players", () => {
  const platform = new PlatformService();
  const creator = platform.registerCreator("pro@example.test", "Pro");
  platform.assignPlan(creator.account.id, "pro");
  const games = createGames(platform, creator, 25, "pro");
  activateAll(platform, creator.account.id, games);
  const limits = platform.projectRuntimeLimits(games[0]!.id);
  assert.equal(limits.plan, "pro");
  assert.equal(limits.maxPlayersPerRoom, 16);
  assert.equal(limits.storedBytes, 2 * GIB);
  platform.assertManifestAllowed(games[0]!.id, serverManifest(16));
  assert.throws(
    () => platform.assertManifestAllowed(games[0]!.id, hostManifest(17)),
    /this plan allows 16 players per room/,
  );
});

test("the master test account is exempt from Free caps and only that exact address", () => {
  assert.equal(isMasterTestAccount(MASTER_TEST_ACCOUNT_EMAIL), true);
  assert.equal(isMasterTestAccount(`  ${MASTER_TEST_ACCOUNT_EMAIL.toUpperCase()} `), true);
  assert.equal(isMasterTestAccount(`x${MASTER_TEST_ACCOUNT_EMAIL}`), false);
  assert.equal(isMasterTestAccount("other@gmail.com"), false);
  assert.equal(isMasterTestAccount(undefined), false);
  assert.equal(entitledPlan(MASTER_TEST_ACCOUNT_EMAIL, { plan: "free", status: "active" }), "pro");
  assert.equal(entitledPlan("other@gmail.com", { plan: "free", status: "active" }), "free");

  const platform = new PlatformService();
  const master = platform.registerCreator(MASTER_TEST_ACCOUNT_EMAIL, "Master");
  const normal = platform.registerCreator("normal@example.test", "Normal");
  const masterGames = createGames(platform, master, 5, "master");
  activateAll(platform, master.account.id, masterGames);
  const masterLimits = platform.projectRuntimeLimits(masterGames[0]!.id);
  assert.equal(masterLimits.maxPlayersPerRoom, 16);
  assert.equal(masterLimits.simultaneousRooms, NAKAMA_ROOM_QUOTA_CAP);
  assert.equal(masterLimits.serverAuthority, true);
  platform.assertManifestAllowed(masterGames[0]!.id, hostManifest(16));

  const normalGames = createGames(platform, normal, 2, "normal");
  assert.throws(
    () => createGames(platform, normal, 1, "normal-extra"),
    /Free allows 2 stored games/,
  );
  platform.transitionProject(normal.account.id, normalGames[0]!.id, "private");
  assert.throws(
    () => platform.transitionProject(normal.account.id, normalGames[1]!.id, "private"),
    /Free allows 1 active game/,
  );
  assert.throws(
    () => platform.assertManifestAllowed(normalGames[0]!.id, hostManifest(8)),
    /this plan allows 4 players per room/,
  );
});

test("the master test account cannot publish to the closed Layer 2 catalog", () => {
  const platform = new PlatformService();
  const master = platform.registerCreator(MASTER_TEST_ACCOUNT_EMAIL, "Master");
  const [project] = createGames(platform, master, 1, "master");
  platform.transitionProject(master.account.id, project!.id, "private");
  assert.throws(
    () => platform.transitionProject(master.account.id, project!.id, "published"),
    /Layer 2 publication is closed/,
  );
});

test("a lapsed paid plan falls back to Free limits, and an unpaid grace period keeps paid ones", () => {
  const platform = new PlatformService();
  const creator = platform.registerCreator("lapse@example.test", "Lapse");
  const [project] = createGames(platform, creator, 1, "lapse");
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();

  platform.assignPlan(creator.account.id, "loki", "past_due", future);
  assert.equal(platform.projectRuntimeLimits(project!.id).plan, "loki");
  assert.equal(platform.projectRuntimeLimits(project!.id).maxPlayersPerRoom, 8);

  platform.assignPlan(creator.account.id, "loki", "canceled", past);
  const limits = platform.projectRuntimeLimits(project!.id);
  assert.equal(limits.plan, "free");
  assert.equal(limits.maxPlayersPerRoom, 4);
  assert.equal(limits.simultaneousRooms, 2);
  assert.equal(limits.serverAuthority, false);
});

test("a downgrade keeps existing games but blocks a new one over the Free cap", () => {
  const platform = new PlatformService();
  const creator = platform.registerCreator("down@example.test", "Down");
  platform.assignPlan(creator.account.id, "loki");
  const games = createGames(platform, creator, 3, "down");
  platform.assignPlan(creator.account.id, "free");
  for (const game of games) {
    assert.equal(platform.getProject(creator.account.id, game.id).id, game.id);
  }
  assert.throws(
    () => createGames(platform, creator, 1, "down-more"),
    /Free allows 2 stored games/,
  );
});
