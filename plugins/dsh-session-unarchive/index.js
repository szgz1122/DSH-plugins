/**
 * Session unarchive helper.
 *
 * When this bundle's row activates, it asks the Host workspace registry to
 * unarchive every Session id listed in the row config. Unarchiving is DSH's
 * native, non-destructive restore for archived Sessions: the Session log on
 * disk is never rewritten, only the workspace bookkeeping changes.
 *
 * Activation is idempotent: unarchiving an already-visible Session is a no-op,
 * and any error is swallowed so a stale id can never break the Host boot.
 */
export const name = 'session-unarchive'
export const inject = ['workspaceRegistry']

export function apply(ctx, config) {
  const sessionIds = Array.isArray(config?.sessionIds) ? config.sessionIds : []

  ctx.effect(() => {
    let disposed = false
    void (async () => {
      for (const sessionId of sessionIds) {
        if (disposed) return
        try {
          await ctx.workspaceRegistry.unarchiveSession(sessionId)
        } catch {
          // Stale id or already-visible Session: keep going.
        }
      }
    })()
    return () => {
      disposed = true
    }
  })
}
