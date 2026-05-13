import { useState, useEffect } from 'react'
import { useAuth } from './useAuth'
import { uploadCustomAvatar, removeCustomAvatar, extractAvatarPath, resolveProfileAvatarUrl, getCachedAvatarUrl } from '../lib/avatarService'
import { AVATAR_SOURCE } from '../lib/avatarConstants'

export function useProfileAvatar() {
  const { user, profile, updateProfile } = useAuth()
  const [isUpdating, setIsUpdating] = useState(false)
  
  const [avatarUrl, setAvatarUrl] = useState(() => getCachedAvatarUrl(profile, user))
  const [isResolving, setIsResolving] = useState(() => !getCachedAvatarUrl(profile, user))

  // 1. Resolve effective avatar URL securely via Signed URLs
  useEffect(() => {
    let mounted = true
    
    // If we already have a perfect synchronous cache hit, skip the spinning state entirely
    const cached = getCachedAvatarUrl(profile, user)
    if (cached && avatarUrl === cached) {
      if (isResolving) setIsResolving(false)
      // We don't abort, we still run loadAvatar subtly in background to re-verify/refresh expiration if needed
      // but without forcing UI into `isResolving = true` spinner.
    } else {
      setIsResolving(true)
    }

    async function loadAvatar() {
      const url = await resolveProfileAvatarUrl(profile, user)
      if (mounted) {
        setAvatarUrl(url)
        setIsResolving(false)
      }
    }

    loadAvatar()

    return () => { mounted = false }
  }, [profile?.avatar_path, profile?.avatar_source, profile?.avatar_url, user?.user_metadata?.avatar_url])

  const applyCustomAvatar = async (blob, source) => {
    if (!user) throw new Error("Must be logged in to update avatar")
    
    // Strict validation before touching Supabase to prevent constraint errors cleanly
    const allowedSources = Object.values(AVATAR_SOURCE)
    if (!allowedSources.includes(source)) {
      console.error(`Invalid avatar_source value attempted: ${source}`)
      throw new Error(`Invalid source provided. Must be one of: ${allowedSources.join(', ')}`)
    }

    setIsUpdating(true)
    try {
      // 1. Upload to storage
      const path = await uploadCustomAvatar(blob, user.id)
      const oldUrl = profile?.avatar_url
      
      // 2. Update DB row with full column set ensuring valid schema constraints
      await updateProfile({
        avatar_url: profile?.avatar_url || null, // Keep legacy untouched, do not store public URL
        avatar_source: source,
        avatar_path: path,
        avatar_updated_at: new Date().toISOString()
      })
      
      // 3. Cleanup old avatar if it was a stored one
      const oldPath = extractAvatarPath(oldUrl)
      if (oldPath && oldPath !== path) {
        await removeCustomAvatar(oldPath)
      }
    } finally {
      setIsUpdating(false)
    }
  }

  const revertToGoogleAvatar = async () => {
    if (!user) return
    setIsUpdating(true)
    try {
      const googleUrl = user?.user_metadata?.avatar_url || null
      const oldUrl = profile?.avatar_url

      await updateProfile({
        avatar_url: googleUrl,
        avatar_source: AVATAR_SOURCE.GOOGLE,
        avatar_path: null,
        avatar_updated_at: new Date().toISOString()
      })

      // Clean up old custom avatar if present
      const oldPath = extractAvatarPath(oldUrl)
      if (oldPath) {
        await removeCustomAvatar(oldPath)
      }
    } finally {
      setIsUpdating(false)
    }
  }

  return {
    avatarUrl,
    isResolving,
    isUpdating,
    applyCustomAvatar,
    revertToGoogleAvatar
  }
}
