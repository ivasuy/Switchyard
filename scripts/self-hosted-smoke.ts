import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServerApp } from "../apps/server/src/app.ts";

async function main(): Promise<void> {
  const objectDir = await mkdtemp(join(tmpdir(), "switchyard-self-hosted-smoke-"));
  const app = await createServerApp({
    host: "127.0.0.1",
    port: 0,
    deploymentMode: "test",
    hostedRuntimeAllowlist: ["fake.deterministic"],
    objectStoreDir: objectDir,
    redactedSummary: {
      deploymentMode: "test"
    }
  });

  try {
    const ready = await app.inject({ method: "GET", url: "/ready" });
    if (ready.statusCode !== 200 || ready.json().ok !== true) {
      throw new Error(`self_hosted_smoke_ready_failed:${ready.statusCode}`);
    }

    const hosted = await app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: {
        runtime: "fake",
        provider: "test",
        model: "test-model",
        adapterType: "process",
        cwd: "/repo",
        task: "self hosted fake smoke",
        placement: "hosted"
      }
    });
    if (hosted.statusCode !== 201 || hosted.json().run.status !== "completed") {
      throw new Error(`self_hosted_smoke_hosted_failed:${hosted.statusCode}`);
    }

    const register = await app.inject({
      method: "POST",
      url: "/nodes/register",
      payload: {
        id: "node_smoke",
        capabilities: ["runtime.fake.deterministic"],
        policy: {
          allowRuntimeModes: ["fake.deterministic"],
          denyAdapterTypes: [],
          allowCwdPrefixes: ["/repo"],
          allowEventTypes: [],
          artifactSync: "full"
        }
      }
    });
    if (register.statusCode !== 201) {
      throw new Error(`self_hosted_smoke_register_failed:${register.statusCode}`);
    }

    const run = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        runtime: "fake",
        provider: "test",
        model: "test-model",
        adapterType: "process",
        cwd: "/repo",
        task: "connected node smoke",
        placement: "connected_local_node"
      }
    });
    if (run.statusCode !== 202) {
      throw new Error(`self_hosted_smoke_run_failed:${run.statusCode}`);
    }

    const claim = await app.inject({
      method: "POST",
      url: "/nodes/node_smoke/assignments/claim",
      payload: {}
    });
    if (claim.statusCode !== 200 || !claim.json().assignment?.id) {
      throw new Error(`self_hosted_smoke_claim_failed:${claim.statusCode}`);
    }
    const assignmentId = claim.json().assignment.id as string;
    const runId = claim.json().run.id as string;

    const event = {
      id: "event_smoke_1",
      type: "runtime.output",
      runId,
      sequence: 1,
      payload: { text: "connected node done" },
      createdAt: new Date().toISOString()
    };
    const syncEvents = await app.inject({
      method: "POST",
      url: `/nodes/node_smoke/assignments/${assignmentId}/events`,
      payload: {
        cursor: 0,
        events: [event]
      }
    });
    if (syncEvents.statusCode !== 200) {
      throw new Error(`self_hosted_smoke_event_sync_failed:${syncEvents.statusCode}`);
    }

    const artifactBytes = Buffer.from(JSON.stringify(event) + "\n", "utf8");
    const artifactId = "artifact_smoke_1";
    const artifactPath = `runs/${runId}/node-smoke.jsonl`;
    const manifest = await app.inject({
      method: "POST",
      url: `/nodes/node_smoke/assignments/${assignmentId}/artifacts/manifest`,
      payload: {
        artifacts: [{
          id: artifactId,
          type: "transcript",
          path: artifactPath,
          contentType: "application/x-ndjson",
          sizeBytes: artifactBytes.byteLength,
          sha256: createHash("sha256").update(artifactBytes).digest("hex"),
          syncContent: false
        }]
      }
    });
    if (manifest.statusCode !== 200) {
      throw new Error(`self_hosted_smoke_manifest_failed:${manifest.statusCode}`);
    }

    const complete = await app.inject({
      method: "POST",
      url: `/nodes/node_smoke/assignments/${assignmentId}/complete`,
      payload: { status: "completed" }
    });
    if (complete.statusCode !== 200 || complete.json().assignment.status !== "completed") {
      throw new Error(`self_hosted_smoke_complete_failed:${complete.statusCode}`);
    }

    process.stdout.write("self-hosted:smoke OK\n");
  } finally {
    await app.close();
    await rm(objectDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
