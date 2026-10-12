import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { Pool } from "pg";
import { MASTER_TEST_ACCOUNT_EMAIL } from "../apps/api/src/master-account.js";

const apiOrigin = process.env.API_ORIGIN ?? process.env.LOKI_PUBLIC_API_ORIGIN;
const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const databaseUrl = process.env.SUPABASE_DATABASE_URL;
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
const terms = process.env.LOKI_TERMS_VERSION;
const privacy = process.env.LOKI_PRIVACY_VERSION;
const aup = process.env.LOKI_AUP_VERSION;
const output =
  process.env.LOKI_PLAN_LIMIT_EVIDENCE ??
  "artifacts/release-2026-10-11/plan-limits.json";

if (!apiOrigin || !supabaseUrl || !anonKey || !databaseUrl || !terms || !privacy || !aup) {
  throw new Error(
    "API origin, Supabase URL, anon key, database URL, and legal versions are required",
  );
}

const id = randomUUID();
const email = `sanborn.li.hk+loki-limit-${id.slice(0, 8)}@gmail.com`;
const password = `Loki-${randomBytes(18).toString("base64url")}!`;
const pool = new Pool({ connectionString: databaseUrl });

const legalHeaders = {
  "x-loki-terms-version": terms,
  "x-loki-privacy-version": privacy,
  "x-loki-aup-version": aup,
};

async function readBody(response: Response): Promise<string> {
  return response.text();
}

async function expectFailure(
  label: string,
  response: Response,
  pattern: RegExp,
): Promise<string> {
  const body = await readBody(response);
  if (response.ok || !pattern.test(body)) {
    throw new Error(
      `${label} expected a refusal matching ${pattern}, got ${response.status}: ${body.slice(0, 300)}`,
    );
  }
  return body;
}

async function signUp(): Promise<{ accessToken: string; authUserId?: string }> {
  const response = await fetch(`${supabaseUrl}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anonKey!, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`signup failed (${response.status}): ${body.slice(0, 300)}`);
  const parsed = JSON.parse(body) as { access_token?: string; user?: { id?: string } };
  if (parsed.access_token) {
    return { accessToken: parsed.access_token, authUserId: parsed.user?.id };
  }
  await pool.query(
    "UPDATE auth.users SET email_confirmed_at = now() WHERE email = $1 AND email_confirmed_at IS NULL",
    [email],
  );
  const session = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey!, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const sessionBody = await session.text();
  if (!session.ok) {
    throw new Error(`signin after signup failed (${session.status}): ${sessionBody.slice(0, 300)}`);
  }
  const token = JSON.parse(sessionBody) as { access_token?: string; user?: { id?: string } };
  if (!token.access_token) throw new Error("signin did not return an access token");
  return { accessToken: token.access_token, authUserId: token.user?.id };
}

function archive(maxPlayers: number): Uint8Array {
  return zipSync({
    "game.json": strToU8(
      JSON.stringify({
        schemaVersion: 1,
        name: "Plan limit check",
        entrypoint: "index.html",
        multiplayer: { enabled: true, authority: "host", maxPlayers, tickRate: 10 },
        networkAllowlist: [],
      }),
    ),
    "index.html": strToU8("<!doctype html><main>plan limit check</main>"),
  });
}

async function deploy(
  headers: Record<string, string>,
  projectId: string,
  maxPlayers: number,
): Promise<Response> {
  const credential = await fetch(
    `${apiOrigin}/v1/projects/${projectId}/deployment-credentials`,
    { method: "POST", headers },
  );
  const credentialBody = await credential.text();
  if (!credential.ok) {
    throw new Error(`credential failed (${credential.status}): ${credentialBody.slice(0, 300)}`);
  }
  const issued = JSON.parse(credentialBody) as { credentialId: string; secret: string };
  return fetch(`${apiOrigin}/v1/deployments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${issued.secret}`,
      "x-loki-credential-id": issued.credentialId,
      "content-type": "application/zip",
    },
    body: Buffer.from(archive(maxPlayers)),
  });
}

let organizationId: string | undefined;
let accountId: string | undefined;
let authUserId: string | undefined;
const createdProjectIds: string[] = [];

try {
  const session = await signUp();
  authUserId = session.authUserId;
  const headers = {
    authorization: `Bearer ${session.accessToken}`,
    "content-type": "application/json",
    ...legalHeaders,
  };
  const organization = await fetch(`${apiOrigin}/v1/organizations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Plan Limit", slug: `limit-${id.slice(0, 8)}` }),
  });
  const organizationBody = await organization.text();
  if (!organization.ok) {
    throw new Error(`organization failed (${organization.status}): ${organizationBody.slice(0, 300)}`);
  }
  organizationId = (JSON.parse(organizationBody) as { id: string }).id;
  const account = await pool.query<{ id: string }>(
    "SELECT id FROM accounts WHERE email = $1",
    [email],
  );
  accountId = account.rows[0]?.id;

  const createProject = async (name: string) =>
    fetch(`${apiOrigin}/v1/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        organizationId,
        name,
        slug: name.toLowerCase().replaceAll(" ", "-"),
      }),
    });

  const first = await createProject("Limit One");
  const firstBody = await first.text();
  if (!first.ok) throw new Error(`first project failed (${first.status}): ${firstBody.slice(0, 300)}`);
  const firstId = (JSON.parse(firstBody) as { id: string }).id;
  createdProjectIds.push(firstId);

  const second = await createProject("Limit Two");
  const secondBody = await second.text();
  if (!second.ok) throw new Error(`second project failed (${second.status}): ${secondBody.slice(0, 300)}`);
  const secondId = (JSON.parse(secondBody) as { id: string }).id;
  createdProjectIds.push(secondId);

  const third = await createProject("Limit Three");
  const thirdRefusal = await expectFailure("third stored game", third, /2 stored games/);

  const activateFirst = await fetch(`${apiOrigin}/v1/projects/${firstId}/state`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ state: "private" }),
  });
  if (!activateFirst.ok) {
    throw new Error(`activating the first game failed (${activateFirst.status}): ${(await activateFirst.text()).slice(0, 300)}`);
  }
  const activateSecond = await fetch(`${apiOrigin}/v1/projects/${secondId}/state`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ state: "private" }),
  });
  const activeRefusal = await expectFailure("second active game", activateSecond, /1 active game/);

  const oversized = await deploy(headers, firstId, 5);
  const roomRefusal = await expectFailure("fifth player", oversized, /4 players per room/);

  let master: Record<string, unknown> = { exercised: false };
  if (serviceRole) {
    const link = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers: {
        apikey: serviceRole,
        authorization: `Bearer ${serviceRole}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "magiclink", email: MASTER_TEST_ACCOUNT_EMAIL }),
    });
    const linkBody = await link.text();
    if (!link.ok) throw new Error(`master link failed (${link.status})`);
    const hashed = (JSON.parse(linkBody) as { hashed_token?: string }).hashed_token;
    const verified = await fetch(`${supabaseUrl}/auth/v1/verify`, {
      method: "POST",
      headers: { apikey: anonKey!, "content-type": "application/json" },
      body: JSON.stringify({ type: "magiclink", token_hash: hashed }),
    });
    const verifiedBody = await verified.text();
    if (!verified.ok) throw new Error(`master verify failed (${verified.status})`);
    const masterToken = (JSON.parse(verifiedBody) as { access_token?: string }).access_token;
    if (!masterToken) throw new Error("master verify did not return a token");
    const masterHeaders = {
      authorization: `Bearer ${masterToken}`,
      "content-type": "application/json",
      ...legalHeaders,
    };
    const overview = await fetch(`${apiOrigin}/v1/creator/overview`, { headers: masterHeaders });
    const overviewBody = await overview.text();
    if (!overview.ok) throw new Error(`master overview failed (${overview.status})`);
    const parsed = JSON.parse(overviewBody) as {
      account?: { plan?: string; limits?: { maxPlayersPerRoom?: number; games?: number | null } };
      organizations?: Array<{ id: string }>;
    };
    const organizationForMaster = parsed.organizations?.[0]?.id;
    if (!organizationForMaster) throw new Error("master account has no organization");
    const extra = await fetch(`${apiOrigin}/v1/projects`, {
      method: "POST",
      headers: masterHeaders,
      body: JSON.stringify({
        organizationId: organizationForMaster,
        name: "Master Limit Check",
        slug: `master-limit-${id.slice(0, 8)}`,
      }),
    });
    const extraBody = await extra.text();
    if (!extra.ok) throw new Error(`master project failed (${extra.status}): ${extraBody.slice(0, 200)}`);
    const extraId = (JSON.parse(extraBody) as { id: string }).id;
    const activated = await fetch(`${apiOrigin}/v1/projects/${extraId}/state`, {
      method: "PATCH",
      headers: masterHeaders,
      body: JSON.stringify({ state: "private" }),
    });
    if (!activated.ok) throw new Error(`master activation failed (${activated.status})`);
    const room = await deploy(masterHeaders, extraId, 8);
    const roomBody = await room.text();
    if (!room.ok) throw new Error(`master eight-player deploy failed (${room.status}): ${roomBody.slice(0, 200)}`);
    await fetch(`${apiOrigin}/v1/projects/${extraId}`, { method: "DELETE", headers: masterHeaders });
    master = {
      exercised: true,
      plan: parsed.account?.plan ?? null,
      gamesCap: parsed.account?.limits?.games ?? null,
      maxPlayersPerRoom: parsed.account?.limits?.maxPlayersPerRoom ?? null,
      createdAndDeletedProject: true,
      eightPlayerDeployAccepted: true,
    };
  }

  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: new URL(apiOrigin).host,
    free: {
      thirdStoredGameRefused: true,
      secondActiveGameRefused: true,
      fifthPlayerRefused: true,
      refusals: {
        storedGames: thirdRefusal.slice(0, 180),
        activeGame: activeRefusal.slice(0, 180),
        players: roomRefusal.slice(0, 180),
      },
    },
    master,
    passed: true,
  };
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, output, masterExercised: master.exercised }));
} finally {
  for (const projectId of createdProjectIds) {
    await pool.query("UPDATE projects SET active_deployment_id = NULL WHERE id = $1", [projectId]).catch(() => undefined);
  }
  if (organizationId) {
    await pool.query("DELETE FROM audit_records WHERE organization_id = $1", [organizationId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE organization_id = $1", [organizationId]).catch(() => undefined);
    await pool.query("DELETE FROM organization_members WHERE organization_id = $1", [organizationId]).catch(() => undefined);
    await pool.query("DELETE FROM organizations WHERE id = $1", [organizationId]).catch(() => undefined);
  }
  if (accountId) await pool.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
  if (authUserId && serviceRole) {
    await fetch(`${supabaseUrl}/auth/v1/admin/users/${authUserId}`, {
      method: "DELETE",
      headers: { apikey: serviceRole, authorization: `Bearer ${serviceRole}` },
    }).catch(() => undefined);
  } else if (!serviceRole) {
    await pool.query("DELETE FROM auth.users WHERE email = $1", [email]).catch(() => undefined);
  }
  await pool.end();
}
