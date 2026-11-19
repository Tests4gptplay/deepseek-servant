import { createHash } from 'node:crypto'

/** Key for observed historical conversion state; no Task is restored here. */
export const localTaskUpgradeKey = (directory: string, taskId: string) => 'framework-upgrade-task/' + createHash('sha256').update(directory + '\0' + taskId).digest('hex');
