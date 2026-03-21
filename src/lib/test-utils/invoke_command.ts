// @ts-expect-error internal API
import { with_request_store } from '@sveltejs/kit/internal/server';

export async function invokeCommand<TArg, TResult>(
  fn: ((arg: TArg) => Promise<TResult>) | (() => Promise<TResult>),
  arg?: TArg
): Promise<TResult> {
  return with_request_store(
    {
      event: {
        request: new Request('http://localhost/_remote', { method: 'POST' }),
        cookies: {
          set: () => {},
          delete: () => {},
        },
      } as never,
      state: {
        allows_commands: true,
        handleValidationError: ({ issues }: { issues: unknown }) => issues,
        transport: {},
      } as never,
    },
    () => fn(arg as TArg)
  );
}
