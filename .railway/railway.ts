import { defineRailway, github, preserve, project, service } from "railway/iac";

// Railway Infrastructure as Code for the PBJBillingApp service (featreq-d84ddb16).
//
// This replaces railway.json, which Railway stops reading on 2026-12-01. Unlike
// that file, THIS one is not read at deploy time: `railway config plan` previews
// and `railway config apply` writes these settings onto the service once, and
// the file is the record of what was applied. Change a setting here, then run
// plan and apply again - and READ THE PLAN: an undeclared variable on the
// declared service is a variable the apply deletes (the first plan of this file
// listed all nineteen for deletion). That is what the `preserve()` entries are:
// "keep whatever Railway has; this file does not manage the value".
//
// Running the CLI here: `npx @railway/cli@latest config plan`. The SDK's runner
// also execs a `railway` binary from PATH to check the CLI version; with the
// npx-only setup that lookup fails, so point it at the cached native binary:
//   env _='D:\DevCache\npm-cache\_npx\<hash>\node_modules\@railway\cli\bin\railway.exe' \
//     "$_" config plan
// (find the hash with `find "$(npm config get cache)/_npx" -name railway.exe`).
// The `railway` npm package is installed with `npm install --no-save railway`;
// it is a developer tool, not a dependency of the app, and is not committed.
//
// Two settings railway.json used to force cannot be expressed in this format
// (the DSL has no builder, dockerfilePath or restart-policy property -
// `railway config migrate` comments the builder out and drops the restart
// policy). They live on the service itself and persist on their own:
//   Build: Railway has no "Dockerfile" builder value (its enum is HEROKU,
//          NIXPACKS, PAKETO, RAILPACK); a Dockerfile in the repo is used
//          automatically, and the service's `dockerfilePath` is pinned to
//          "Dockerfile" (set 2026-10-06 through the API; the dashboard's
//          RAILWAY_DOCKERFILE_PATH does the same). That is the pinned Node +
//          npm image that ended the 2026-09-03 outage; see the Dockerfile's header.
//   Deploy > Restart policy: On failure, 10 retries - already Railway's stored
//            value for this service (checked 2026-10-06 through the API).
//
// This repository manages only its own service in the environment (the
// Postgres database and its volume are not declared here and are left alone).
// Railway's README calls a named partial a last resort, for when "omit means
// delete" is a blocker - which it is here: without the partial a whole-project
// apply would treat the undeclared database and volume as removals.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "PBJBillingApp";

export default defineRailway(() => {
  const PBJBillingApp = service("PBJBillingApp", {
    // What the service already is, stated so an apply has nothing to remove.
    source: github("shizzoobies/PBJBillingApp", { checkSuites: false }),
    replicas: { "us-east4-eqdc4a": 1 },
    domains: ["app.pbjsa.com"],
    networking: { privateNetworkEndpoint: "pbjbillingapp" },
    // Every service variable, preserved: values are set in the dashboard (or
    // `railway variables --set`), never here. Adding a variable there means
    // adding its name here before the next apply, or the apply deletes it.
    env: {
      ADMIN_EMAIL: preserve(),
      ANTHROPIC_API_KEY: preserve(),
      APP_PUBLIC_URL: preserve(),
      DATABASE_URL: preserve(),
      ELEVENLABS_AGENT_ID: preserve(),
      ELEVENLABS_API_KEY: preserve(),
      ELEVENLABS_WEBHOOK_SECRET: preserve(),
      EMAIL_FROM: preserve(),
      INVOICE_EMAIL_FROM: preserve(),
      INVOICE_REPLY_TO: preserve(),
      JWT_SECRET: preserve(),
      NODE_ENV: preserve(),
      OWNER_BOOTSTRAP_PASSWORD: preserve(),
      OWNER_EMAIL: preserve(),
      RESEND_API_KEY: preserve(),
      RESEND_WEBHOOK_SECRET: preserve(),
      STRIPE_SECRET_KEY: preserve(),
      STRIPE_WEBHOOK_SECRET: preserve(),
      VOICE_TOOL_SECRET: preserve(),
    },
    // From railway.json. The Dockerfile's CMD is the same command, so a build
    // that somehow lost this line would still start the same way.
    start: "npm start",
    // The deploy is live only once /health answers 200 (it answers 503 while
    // the database is unreachable), within two minutes of the container start.
    healthcheck: "/health",
    healthcheckTimeout: 120,
  });
  return project("PB&J App", {
    resources: [PBJBillingApp],
  });
});
