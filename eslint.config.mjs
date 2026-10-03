import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Package layering (#39). Each package may import only the @netrics packages
// listed here; inner layers never depend on outer ones, and the concrete
// connector bundle is composed by the app, not the runtime. Apps may import
// any package.
export const PACKAGE_LAYERS = {
  domain: [],
  contracts: ["domain"],
  "connector-sdk": [],
  connectors: ["connector-sdk"],
  "connector-runtime": ["connector-sdk"],
  database: ["domain", "contracts"],
  ui: ["domain", "contracts"],
};

function layerRule(name, allowed) {
  return {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: [
              "@netrics/*",
              ...allowed.flatMap((dep) => [
                `!@netrics/${dep}`,
                `!@netrics/${dep}/*`,
              ]),
            ],
            message: `@netrics/${name} may import only ${
              allowed.length > 0
                ? allowed.map((dep) => `@netrics/${dep}`).join(", ")
                : "no other @netrics package"
            } (PACKAGE_LAYERS in eslint.config.mjs).`,
          },
        ],
      },
    ],
  };
}

function webApiFetchRestrictions() {
  const message =
    "Call the API through apiFetch (apps/web/src/lib/api-fetch, #155), not fetch.";
  const env =
    "MemberExpression[object.object.name='process'][object.property.name='env']";
  const fetchArg = (selector) =>
    `CallExpression[callee.name='fetch'] > ${selector}.arguments:first-child`;
  return [
    {
      selector: `${env}[property.name='NETRICS_API_URL']`,
      message:
        "NETRICS_API_URL is read only by apiFetch (lib/api-fetch, #155).",
    },
    {
      selector: `${env}[property.value='NETRICS_API_URL']`,
      message:
        "NETRICS_API_URL is read only by apiFetch (lib/api-fetch, #155).",
    },
    // fetch(`${base}/v1/…`), fetch(new URL(…)), fetch("http://…"): an
    // absolute URL rather than a same-origin path.
    { selector: fetchArg("TemplateLiteral[quasis.0.value.raw='']"), message },
    { selector: fetchArg("NewExpression"), message },
    {
      selector: fetchArg("Literal[value=/^[a-z][a-z0-9+.-]*:|^\\/\\//i]"),
      message,
    },
  ];
}

const layering = [
  ...Object.entries(PACKAGE_LAYERS).map(([name, allowed]) => ({
    files: [`packages/${name}/**/*.{ts,tsx}`],
    rules: layerRule(name, allowed),
  })),
  // Route files stay thin: queries live in @netrics/database, use cases in
  // apps/server/src/connections etc. (#38).
  {
    files: ["apps/server/src/routes/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "drizzle-orm",
              message:
                "Route files contain no queries; add a function to @netrics/database.",
            },
            {
              name: "@netrics/database",
              importNames: ["schema"],
              message:
                "Route files contain no queries; add a function to @netrics/database.",
            },
          ],
          patterns: [
            {
              group: ["drizzle-orm/*"],
              message:
                "Route files contain no queries; add a function to @netrics/database.",
            },
          ],
        },
      ],
    },
  },
  // Every web→API request goes through apiFetch (apps/web/src/lib/api-fetch,
  // #155), the one place that resolves NETRICS_API_URL and sets the headers
  // each call must carry. Browser code fetches same-origin relative paths.
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    ignores: ["apps/web/src/lib/api-fetch.ts", "apps/web/src/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...webApiFetchRestrictions()],
    },
  },
  // Runtime tests exercise the real demo connector as a fixture.
  {
    files: ["packages/connector-runtime/**/*.test.ts"],
    rules: layerRule("connector-runtime", ["connector-sdk", "connectors"]),
  },
];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/out/**",
      "**/coverage/**",
      "**/drizzle/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // CommonJS config files (.pnpmfile.cjs).
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { module: "writable", require: "readonly" },
    },
  },
  ...layering,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
