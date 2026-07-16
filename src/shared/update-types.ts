export type UpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export type AppUpdateState = {
  status: UpdateStatus;
  currentVersion: string;
  version?: string;
  percent?: number;
  message?: string;
};
