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

const layering = [
  ...Object.entries(PACKAGE_LAYERS).map(([name, allowed]) => ({
    files: [`packages/${name}/**/*.{ts,tsx}`],
    rules: layerRule(name, allowed),
  })),
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
