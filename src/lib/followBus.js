// Tiny pub-sub that notifies all mounted game-feed hook instances whenever the
// user's follow set changes. This allows useUpcomingGames and useDiscoverGames
// to re-fetch stale feed data without remounting or passing props.
const _listeners = new Set()
let _version = 0

export const followBus = {
  subscribe(fn) {
    _listeners.add(fn)
    return () => _listeners.delete(fn)
  },
  emit() {
    _version++
    _listeners.forEach(fn => fn(_version))
  },
  getVersion() {
    return _version
  },
}
