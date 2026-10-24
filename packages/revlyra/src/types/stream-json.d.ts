declare module 'stream-json' {
  import type { Transform } from 'node:stream';

  const value: {
    parser(options?: Record<string, unknown>): Transform;
    stringer(options?: Record<string, unknown>): Transform;
  };
  export default value;
}

declare module 'stream-json/streamers/StreamArray.js' {
  import type { Transform } from 'node:stream';

  const value: {
    streamArray(options?: Record<string, unknown>): Transform;
  };
  export default value;
}
