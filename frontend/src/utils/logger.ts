const logger = {
  info: (message: string, data?: any) => {
    console.log(`[INFO] ${message}`, data ?? '');
  },
  error: (message: string, error?: any) => {
    console.error(`[ERROR] ${message}`, error ?? '');
  },
  warn: (message: string, data?: any) => {
    console.warn(`[WARN] ${message}`, data ?? '');
  },
  debug: (message: string, data?: any) => {
    if (import.meta.env.DEV) {
      console.log(`[DEBUG] ${message}`, data ?? '');
    }
  },
};

export default logger;
