import { Company } from './controller.mjs';
import { init } from './config.mjs';
export async function command(root, subcommand = 'status', argument, options = {}) {
  if (subcommand === 'init') return init(root);
  const company = new Company(root, options);
  if (subcommand === 'status') return JSON.stringify(company.status(),null,2);
  if (subcommand === 'stop' && argument) return company.stop(argument);
  if (['run','challenge'].includes(subcommand) && argument) return JSON.stringify(await company.run(argument,{challenge:subcommand === 'challenge',signal:options.signal}),null,2);
  if (subcommand === 'apply') throw new Error('Automatic apply is not supported. Use company status to find trial.workspace, inspect git -C PATH diff and status, then copy reviewed changes manually. Your source checkout has not changed.');
  throw new Error('Use company init | status | run <mission.json> | challenge <mission.json> | stop <run-id>');
}
