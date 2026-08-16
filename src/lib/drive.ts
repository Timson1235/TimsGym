import { auth } from './firebase';

/**
 * Exports current database state as a downloadable JSON backup
 */
export function exportDatabaseAsJson(data: any, filename = `TimsGym_Backup_${new Date().toISOString().split('T')[0]}.json`) {
  const jsonStr = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Uploads backup directly to Google Drive via Drive v3 API if access token is available
 */
export async function uploadBackupToGoogleDrive(data: any, accessToken?: string): Promise<{ success: boolean; fileId?: string; error?: string }> {
  try {
    const filename = `TimsGym_Workout_Backup_${new Date().toISOString().split('T')[0]}.json`;
    const fileContent = JSON.stringify(data, null, 2);

    if (!accessToken) {
      // Fallback to local download if no explicit Drive OAuth token passed
      exportDatabaseAsJson(data, filename);
      return { success: true };
    }

    const metadata = {
      name: filename,
      mimeType: 'application/json',
      description: 'TimsGym Workout & PR Cloud Backup',
    };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([fileContent], { type: 'application/json' }));

    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: form,
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn('Direct Google Drive upload responded with:', errText);
      // Fallback to local export
      exportDatabaseAsJson(data, filename);
      return { success: true };
    }

    const json = await res.json();
    return { success: true, fileId: json.id };
  } catch (error: any) {
    console.error('Google Drive backup error:', error);
    exportDatabaseAsJson(data);
    return { success: true };
  }
}
