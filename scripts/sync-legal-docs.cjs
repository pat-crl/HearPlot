/*
  Rebuild PRIVACY.md and TERMS.md from legal-content.js.
  Keeping this step small makes the legal wording easier to update safely.
*/

const fs = require("fs");
const path = require("path");
const legal = require("../legal-content.js");

function markdownFor(documentDetails) {
  const header = [
    `# ${documentDetails.title}`,
    "",
    "**Music Analyser**",
    "",
    `Effective date: ${legal.effectiveDate}`,
    `Developer: ${legal.developer}`,
    "",
    documentDetails.summary,
  ];

  const sections = documentDetails.sections.flatMap((section) => [
    "",
    `## ${section.heading}`,
    "",
    // Markdown needs a blank line between paragraphs so the rendered documents stay easy to read.
    ...section.paragraphs.flatMap((paragraph, index) => (index ? ["", paragraph] : [paragraph])),
  ]);

  return [...header, ...sections, ""].join("\n");
}

for (const [key, filename] of [["privacy", "PRIVACY.md"], ["terms", "TERMS.md"]]) {
  fs.writeFileSync(path.join(__dirname, "..", filename), markdownFor(legal.documents[key]));
}
