export type MigrationFile = {
  readonly version: string;
  readonly name: string;
  readonly fileName: string;
  readonly absolutePath: string;
  readonly content: string;
  readonly transactional: boolean;
};
