import { join } from "node:path";

export function agentKitInstallPlan(root: string, installSkill: boolean) {
  const projectId = "11111111-1111-4111-8111-111111111111";
  return {
    schema: 1,
    origin: "https://homing.test",
    package_version: 3,
    os: "linux",
    home: join(root, "home"),
    worker: { role: "local", machine_slug: "test-worker" },
    paths: {
      config: join(root, "config"),
      state: join(root, "state"),
      logs: join(root, "logs"),
      skill: join(root, "skills"),
    },
    scheduler: {
      kind: "none",
      identifier: "homing-check-test",
      hour: 9,
      minute: 37,
      cadence_minutes: 1440,
    },
    secret_store: {
      kind: "file",
      service: "homing-api-token",
      path: join(root, "credential-store", "token"),
    },
    runtime: {
      kind: "none",
      invocation_argv: [],
      install_skill: installSkill,
      skill_flavour: "portable",
    },
    isolation_rung: 3,
    lanes: ["example:sitemap"],
    sources: {
      schema: 1,
      allowed_hosts: ["example.test"],
      sources: [
        {
          slug: "example",
          lane: "example:sitemap",
          url_template: "https://example.test/listings",
          permitted_by: "published sitemap",
        },
      ],
      project_prompt_revisions: { [projectId]: 1 },
    },
  };
}
