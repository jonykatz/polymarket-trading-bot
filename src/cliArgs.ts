export type CliArgs = {
  singleTrade: boolean;
};

export function parseCliArgs(argv: string[] = process.argv.slice(2)): CliArgs {
  return {
    singleTrade: argv.includes("--single-trade")
  };
}
