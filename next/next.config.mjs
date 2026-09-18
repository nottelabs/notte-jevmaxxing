/** @type {import('next').NextConfig} */
export default {
  // ws is a plain Node dependency of the streaming route; keep it out of the bundler.
  serverExternalPackages: ["ws", "notte-sdk"],
  // `next dev` opened as 127.0.0.1 instead of localhost would otherwise never hydrate.
  allowedDevOrigins: ["127.0.0.1"],
};
