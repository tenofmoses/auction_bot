declare module 'node-telegram-bot-api' {
  export type Chat = {
    id: number | string;
    type: string;
  };

  export type Message = {
    message_id?: number;
    chat: Chat;
    text?: string;
    photo?: Array<{ file_id: string }>;
    from?: {
      id: number | string;
      username?: string;
    };
  };

  export type CallbackQuery = {
    id: string;
    data?: string;
    from: {
      id: number | string;
      username?: string;
    };
    message?: Message;
  };

  export type TelegramBotOptions = {
    polling?: boolean;
  };

  export type PollingError = {
    code?: string;
    message?: string;
    response?: unknown;
  };

  export type SendMessageOptions = {
    parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
    disable_web_page_preview?: boolean;
    reply_markup?: {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
  };

  export type SendPhotoOptions = SendMessageOptions & {
    caption?: string;
  };

  export type BotUser = {
    id: number;
    username?: string;
    can_join_groups?: boolean;
    can_read_all_group_messages?: boolean;
  };

  export default class TelegramBot {
    constructor(token: string, options?: TelegramBotOptions);
    on(event: 'message', listener: (msg: Message) => void | Promise<void>): void;
    on(event: 'callback_query', listener: (query: CallbackQuery) => void | Promise<void>): void;
    on(event: 'polling_error', listener: (error: PollingError) => void | Promise<void>): void;
    on(event: 'error', listener: (error: PollingError) => void | Promise<void>): void;
    getMe(): Promise<BotUser>;
    sendMessage(chatId: number | string, text: string, options?: SendMessageOptions): Promise<Message>;
    sendPhoto(chatId: number | string, photo: string, options?: SendPhotoOptions): Promise<Message>;
    deleteMessage(chatId: number | string, messageId: number): Promise<boolean>;
    answerCallbackQuery(callbackQueryId: string, options?: { text?: string; show_alert?: boolean }): Promise<boolean>;
  }
}
