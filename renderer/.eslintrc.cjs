/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  extends: ["next/core-web-vitals"],
  rules: {
    // Guardrail: prevent giant god-files from creeping back in.
    "max-lines": ["error", { max: 260, skipBlankLines: true, skipComments: true }],
  },
  overrides: [
    {
      files: ["app/page.tsx"],
      rules: {
        "max-lines": ["error", { max: 200, skipBlankLines: true, skipComments: true }],
      },
    },
  ],
};

