import loginGuide from "../commands/login/login.guide.md" with { type: "text" };
import startGuide from "../commands/start/start.guide.md" with { type: "text" };

interface GuideEntry {
  readonly template: string;
  readonly skillName: string;
  readonly skillDescription: string;
}

const guides = new Map<string, GuideEntry>([
  [
    "login",
    {
      template: loginGuide,
      skillName: "supabase-login",
      skillDescription:
        "Use when you need to authenticate, log in, or set up credentials for the Supabase CLI before running commands that require auth",
    },
  ],
  [
    "start",
    {
      template: startGuide,
      skillName: "supabase-start",
      skillDescription:
        "Use when you need to start, watch, or run the local Supabase development stack for local app development and testing",
    },
  ],
]);

export function getGuide(commandPath: ReadonlyArray<string>): GuideEntry | undefined {
  const key = commandPath.join(" ");
  return guides.get(key);
}
