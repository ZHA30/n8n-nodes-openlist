import { configWithoutCloudSupport } from "@n8n/node-cli/eslint";
export default [
  ...configWithoutCloudSupport,
  {
    files: ["package.json"],
    rules: {
      "@n8n/community-nodes/valid-author": "off",
      "@n8n/community-nodes/require-homepage": "off",
      "n8n-nodes-base/community-package-json-author-missing": "off",
    },
  },
];
