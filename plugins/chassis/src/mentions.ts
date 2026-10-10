export interface MentionPerson {
  principalId: string;
  displayName: string;
  slackId?: string;
}

const WIRE_MENTION = /<@([^>|]+)(?:\|([^>]*))?>/g;

function namePattern(name: string): RegExp {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_@./<>|+-])@${escaped}(?=$|[\\s\\p{P}])`, "giu");
}

export function mentionText(text: string): string {
  return text.replace(WIRE_MENTION, (_token, id: string, name: string | undefined) => `@${name || id}`);
}

export function mentionPeople(text: string): MentionPerson[] {
  return [...text.matchAll(WIRE_MENTION)]
    .filter((match) => match[2])
    .map((match) => ({ principalId: match[1]!, displayName: match[2]! }));
}

export function encodeMentions(text: string, people: readonly MentionPerson[]): string {
  for (const person of [...people].sort((a, b) => b.displayName.length - a.displayName.length)) {
    if (!person.displayName.trim()) continue;
    text = text
      .split(/(<@[^>]+>)/g)
      .map((part) =>
        part.startsWith("<@")
          ? part
          : part.replace(
              namePattern(person.displayName),
              (_match, prefix: string) =>
                `${prefix}<@${person.principalId}|${person.displayName.replace(/[<>|\r\n]/g, " ")}>`,
            ),
      )
      .join("");
  }
  return text;
}

export function mentionsPerson(text: string, person: MentionPerson): boolean {
  if ([...text.matchAll(WIRE_MENTION)].some((match) => match[1] === person.principalId || match[1] === person.slackId))
    return true;
  return [person.displayName, person.principalId].some(
    (name) => name.trim() && namePattern(name).test(text.replace(WIRE_MENTION, "")),
  );
}
