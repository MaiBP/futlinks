export {};

declare global {
  interface Window {
    __onGCastApiAvailable?: (isAvailable: boolean) => void;
    cast?: {
      framework: {
        CastContext: {
          getInstance: () => CastContext;
        };
      };
    };
    chrome?: {
      cast: {
        AutoJoinPolicy: {
          ORIGIN_SCOPED: string;
        };
        media: {
          DEFAULT_MEDIA_RECEIVER_APP_ID: string;
          StreamType: {
            LIVE: string;
          };
          GenericMediaMetadata: new () => {
            title?: string;
          };
          MediaInfo: new (contentId: string, contentType: string) => {
            metadata?: { title?: string };
            streamType?: string;
          };
          LoadRequest: new (mediaInfo: unknown) => {
            autoplay?: boolean;
          };
        };
      };
    };
  }

  type CastContext = {
    setOptions: (options: { receiverApplicationId: string; autoJoinPolicy?: string }) => void;
    getCurrentSession: () => CastSession | null;
    requestSession: () => Promise<CastSession>;
  };

  type CastSession = {
    loadMedia: (request: unknown) => Promise<void>;
  };
}
