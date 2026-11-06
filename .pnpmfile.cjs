// better-auth declares every framework it has an integration for as an
// optional peer (next, drizzle-kit, vitest, svelte, prisma, …). pnpm links an
// optional peer whenever the workspace installs it anywhere, so the server's
// better-auth got `next` from apps/web and `pnpm deploy --prod` shipped
// ~300 MB of Next.js and build tooling in the server image (#81).
//
// We use better-auth's core, its drizzle adapter and `better-auth/react` in
// the web app. Keep exactly those peers; drop the rest. Using another
// integration (for example `better-auth/next-js`) means adding its peer here.
const KEEP_PEERS = new Set(["drizzle-orm", "react", "react-dom"]);

function readPackage(pkg) {
  if (pkg.name === "better-auth" && pkg.peerDependencies) {
    for (const name of Object.keys(pkg.peerDependencies)) {
      if (!KEEP_PEERS.has(name)) {
        delete pkg.peerDependencies[name];
        if (pkg.peerDependenciesMeta) {
          delete pkg.peerDependenciesMeta[name];
        }
      }
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
