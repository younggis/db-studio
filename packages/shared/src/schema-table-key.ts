export function schemaTableKey(schema: string, table: string): string {
  return JSON.stringify([schema, table]);
}
