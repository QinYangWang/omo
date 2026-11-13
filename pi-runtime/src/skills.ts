// Skills are markdown instruction packs discovered by the Go host from the
// workspace and the omo config directory. They are listed in the system
// prompt (sorted, so the prefix stays byte-stable for provider prompt
// caching) and loaded on demand with use_skill.
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { hitSkill } from "./metrics";

export type SkillInfo = {
  name: string;
  description: string;
  path: string;
  content: string;
};

let skills: SkillInfo[] = [];

export const setSkills = (list: SkillInfo[] | undefined) => {
  skills = (Array.isArray(list) ? list : [])
    .filter((skill) => skill && skill.name)
    .map((skill) => ({ ...skill, content: String(skill.content ?? "") }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const renderSkills = () => {
  if (skills.length === 0) return undefined;
  const lines = [
    "",
    "",
    "The following skills provide specialized instructions for specific tasks.",
    "Call use_skill with the skill's name when a task matches its description, then follow its instructions.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.path)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
};

const useSkill = defineTool({
  name: "use_skill",
  description:
    "Load the full instructions of one of the skills listed in <available_skills>. Pass the skill's name and follow the returned instructions.",
  parameters: obj({ name: str() }),
  execute: async (args: any, api: any) => {
    const wanted = String(args.name ?? "").trim().toLowerCase();
    const skill = skills.find((item) => item.name.toLowerCase() === wanted);
    if (!skill) {
      const names = skills.map((item) => item.name).join(", ") || "none";
      return { output: [{ type: "text" as const, text: `Unknown skill ${JSON.stringify(args.name)}. Available skills: ${names}.` }] };
    }
    hitSkill(api.conversationId, skill.name);
    const text = `${skill.content}\n\nSkill directory: ${skill.path}`;
    return { output: [{ type: "text" as const, text }], details: { skill: skill.name, path: skill.path } };
  },
});

export const skillsExtension = defineExtension({
  name: "skills",
  sections: [section("skills", () => renderSkills())],
  tools: [useSkill],
});

// A skill counts as used when a tool reads its SKILL.md, whether through
// use_skill or by reading the <location> the prompt lists. Only the skill file
// itself is matched, not other files next to it.
export const skillForPath = (path: string) => {
  const norm = (value: string) => String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const wanted = norm(path);
  if (!wanted) return undefined;
  return skills.find((skill) => {
    const file = norm(skill.path);
    return file === wanted || file.endsWith(`/${wanted}`);
  });
};
