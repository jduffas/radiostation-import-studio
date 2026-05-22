/**
 * Notarisation macOS — appelé par electron-builder après la signature.
 * Ne fait rien si les variables d'environnement Apple ne sont pas définies
 * (build local sans compte développeur), ou si l'app n'est pas signée avec
 * un Developer ID valide.
 */

const { notarize } = require('@electron/notarize');
const { execSync } = require('child_process');
const path = require('path');

function isSignedWithDeveloperId(appPath) {
  try {
    const output = execSync(`codesign -dv --verbose=4 "${appPath}" 2>&1`, { encoding: 'utf8' });
    return output.includes('TeamIdentifier=');
  } catch {
    return false;
  }
}

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log('[notarize] Variables APPLE_ID/APPLE_APP_PASSWORD/APPLE_TEAM_ID absentes — notarisation ignorée');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  if (!isSignedWithDeveloperId(appPath)) {
    console.log('[notarize] App non signée avec un Developer ID valide — notarisation ignorée');
    return;
  }

  console.log(`[notarize] Notarisation de ${appPath}...`);

  await notarize({
    tool: 'notarytool',
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });

  console.log('[notarize] Notarisation terminée.');
};
