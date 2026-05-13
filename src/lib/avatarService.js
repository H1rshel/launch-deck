import { supabase } from './supabase'
import { AVATAR_SOURCE } from './avatarConstants'

/**
 * Uploads an avatar image Blob to the 'avatars' bucket.
 * Uses a timestamped filename to ensure cache-busting on the frontend.
 *
 * @param {Blob} blob - The image file blob
 * @param {string} userId - The unique user ID
 * @returns {Promise<string>} The storage path inside the bucket
 */
export async function uploadCustomAvatar(blob, userId) {
  const timestamp = Date.now()
  // We use .png or .jpg depending on the blob type, fallback to .jpg
  const ext = blob.type === 'image/png' ? 'png' : 'jpg'
  const path = `${userId}/avatar_${timestamp}.${ext}`

  const { data, error } = await supabase.storage
    .from('avatars')
    .upload(path, blob, {
      contentType: blob.type || 'image/jpeg',
      upsert: false
    })

  if (error) {
    throw new Error(error.message || 'Failed to upload avatar to storage')
  }

  return data.path
}

/**
 * Deletes an avatar file from the 'avatars' bucket.
 *
 * @param {string} path - The exact path inside the avatars bucket
 */
export async function removeCustomAvatar(path) {
  if (!path || typeof path !== 'string' || path.trim() === '') return
  const { error } = await supabase.storage.from('avatars').remove([path])
  if (error) {
    console.error("Failed to remove old avatar:", error)
  }
}


/**
 * Extracts the storage target path from a public Supabase storage URL.
 *
 * @param {string} url - The complete URL string
 * @returns {string|null} The trailing bucket path or null if it's not a Supabase avatar url
 */
export function extractAvatarPath(url) {
  if (!url) return null
  const publicSlug = '/storage/v1/object/public/avatars/'
  const signSlug = '/storage/v1/object/sign/avatars/'
  
  if (url.includes(publicSlug)) {
    return url.substring(url.indexOf(publicSlug) + publicSlug.length).split('?')[0]
  }
  if (url.includes(signSlug)) {
    return url.substring(url.indexOf(signSlug) + signSlug.length).split('?')[0]
  }
  return null
}

let signedUrlCache = {
  path: null,
  url: null,
  expiresAt: 0
}

/**
 * Gets a synchronously available avatar URL perfectly from cache or fallback
 * without requiring network resolution. This prevents UI skeleton flashing.
 */
export function getCachedAvatarUrl(profile, user) {
  if (!profile && !user) return null

  const source = profile?.avatar_source

  if (source === AVATAR_SOURCE.GOOGLE) {
    return profile?.avatar_url || user?.user_metadata?.avatar_url || null
  }

  if (source === AVATAR_SOURCE.UPLOADED || source === AVATAR_SOURCE.SEARCH) {
    if (profile.avatar_path && signedUrlCache.path === profile.avatar_path && Date.now() < signedUrlCache.expiresAt) {
      return signedUrlCache.url
    }
    return null // Cache miss requires async resolution
  }

  return profile?.avatar_url || user?.user_metadata?.avatar_url || null
}

/**
 * Resolves the final URL for an avatar depending on its source logic.
 * 
 * @param {Object} profile - User's local profile document
 * @param {Object} user - User's top-level authentication record
 * @returns {string|null} Resolved avatar public URL or null
 */
export async function resolveProfileAvatarUrl(profile, user) {
  if (!profile && !user) return null

  const cached = getCachedAvatarUrl(profile, user)
  if (cached) return cached

  const source = profile?.avatar_source

  if (source === AVATAR_SOURCE.UPLOADED || source === AVATAR_SOURCE.SEARCH) {
    if (profile.avatar_path) {
      try {
        const { data, error } = await supabase.storage
          .from('avatars')
          .createSignedUrl(profile.avatar_path, 60 * 60 * 24 * 7) // 1 week

        if (error) {
          console.error(`[Avatar] Signed URL generation failed for ${profile.avatar_path}:`, error)
          return profile?.avatar_url || user?.user_metadata?.avatar_url || null
        }
        
        signedUrlCache = {
          path: profile.avatar_path,
          url: data.signedUrl,
          expiresAt: Date.now() + (60 * 60 * 24 * 7 * 1000) - (1000 * 60) // 1 week minus 1 min buffer
        }
        
        return data.signedUrl
      } catch (err) {
        console.error(`[Avatar] Fatal error generating signed URL:`, err)
        return profile?.avatar_url || user?.user_metadata?.avatar_url || null
      }
    } else {
      console.warn(`[Avatar] Missing avatar_path for custom source: ${source}`)
    }
  }

  if (source === AVATAR_SOURCE.GOOGLE) {
    return profile?.avatar_url || user?.user_metadata?.avatar_url || null
  }

  // Fallback purely targeting backward compatibility or cases where avatar_source is unset
  return profile?.avatar_url || user?.user_metadata?.avatar_url || null
}
