declare global {
  interface GoogleCredentialResponse {
    credential: string;
    select_by?: string;
  }

  interface GoogleIdConfiguration {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
    ux_mode?: 'popup' | 'redirect';
    use_one_tap?: boolean;
    auto_select?: boolean;
  }

  interface GoogleButtonConfiguration {
    theme?: 'outline' | 'filled_blue' | 'filled_black';
    size?: 'large' | 'medium' | 'small';
    width?: number;
    text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
  }

  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize: (configuration: GoogleIdConfiguration) => void;
          renderButton: (parent: HTMLElement, options: GoogleButtonConfiguration) => void;
          disableAutoSelect?: () => void;
        };
      };
    };
  }
}

export {};
