import type { GranolaAPI } from '../../preload'

declare global {
  interface Window {
    granola: GranolaAPI
  }
}
