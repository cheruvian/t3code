import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";

const { readFileSync, readdirSync } = NodeFS;

function extractStages(config) {
  const starts = [...config.matchAll(/^ {6}- ([a-z0-9-]+):\s*$/gim)];

  return starts.map((start, index) => ({
    name: start[1],
    block: config.slice(start.index, starts[index + 1]?.index),
  }));
}

function readApprovalType(stage) {
  return (
    stage?.block.match(/^\s+approval:\s*(?:\{\s*)?(?:\r?\n\s*)?type:\s*([a-z-]+)/im)?.[1] ??
    "success"
  );
}

function readScalar(config, key) {
  return config.match(new RegExp(`^\\s+${key}:\\s*([^#\\r\\n]+?)\\s*$`, "m"))?.[1];
}

it("automatically deploys production after a successful main build", () => {
  const config = readFileSync(new URL("../../t3code-main.gocd.yaml", import.meta.url), "utf8");
  const stages = extractStages(config);
  const buildStageIndex = stages.findIndex((stage) => stage.name === "build");
  const deployStage = stages[buildStageIndex + 1];

  assert.notEqual(buildStageIndex, -1, "the main pipeline must include its build stage");
  assert.equal(
    deployStage?.name,
    "deploy-main",
    "deploy-main must immediately follow the main build stage",
  );
  assert.equal(
    readApprovalType(deployStage),
    "success",
    "deploy-main must start automatically when the build succeeds",
  );
});

it("keeps production verification inside the locked deploy transaction", () => {
  const config = readFileSync(new URL("../../t3code-main.gocd.yaml", import.meta.url), "utf8");
  const stages = extractStages(config);
  const deployStageIndex = stages.findIndex((stage) => stage.name === "deploy-main");
  const deployStage = stages[deployStageIndex];

  assert.notEqual(deployStageIndex, -1, "the main pipeline must include deploy-main");
  assert.match(
    deployStage.block,
    /arguments:\s*\[scripts\/gocd\/local-pipeline\.mjs,\s*deploy,\s*production\]/,
    "deploy-main must run the locked production deployment transaction",
  );
  assert.deepStrictEqual(
    {
      hasSeparateVerifyStage: stages.some((stage) => stage.name === "verify-main"),
      invokesVerifierAfterDeploy: stages
        .slice(deployStageIndex + 1)
        .some((stage) => stage.block.includes("verify-production.mjs")),
    },
    {
      hasSeparateVerifyStage: false,
      invokesVerifierAfterDeploy: false,
    },
    "production verification must not run after deploy-main releases its operation lock",
  );
});

it("keeps production rollback manual while tracking fork main", () => {
  const repositoryRoot = new URL("../../", import.meta.url);
  const rollbackConfigs = readdirSync(repositoryRoot)
    .filter(
      (name) =>
        name.endsWith(".gocd.yaml") &&
        name !== "t3code-main.gocd.yaml" &&
        name !== "t3code-candidate.gocd.yaml",
    )
    .map((name) => ({
      name,
      config: readFileSync(new URL(name, repositoryRoot), "utf8"),
    }))
    .filter(({ config }) => /\brollback\b/i.test(config) && /\bproduction\b/i.test(config));

  assert.equal(
    rollbackConfigs.length,
    1,
    "one dedicated production rollback GoCD config must exist",
  );

  const rollbackConfig = rollbackConfigs[0].config;
  const firstStage = extractStages(rollbackConfig)[0];

  assert.equal(
    readApprovalType(firstStage),
    "manual",
    "the first production rollback stage must require manual approval",
  );
  assert.equal(readScalar(rollbackConfig, "git"), "https://github.com/cheruvian/t3code.git");
  assert.equal(readScalar(rollbackConfig, "branch"), "main");
  assert.equal(
    readScalar(rollbackConfig, "auto_update"),
    "true",
    "fork main updates must be observed without automatically scheduling rollback",
  );
});
