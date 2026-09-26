import type { APIRoute } from 'astro'
import { handleCallback } from '../../server/auth/oidc.js'

export const GET: APIRoute = ({ request }) => handleCallback(request)
