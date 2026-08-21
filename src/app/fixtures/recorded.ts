import raw from './recentchange.ndjson';
import type { RecentChange } from '../wiki-stream';

/**
 * 300 consecutive events recorded off the live `recentchange` firehose, one raw
 * JSON payload per line, unedited. The tests replay this instead of opening a
 * connection, so they run offline and give the same answer every time.
 */
export const RECORDED: readonly RecentChange[] = raw
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as RecentChange);
