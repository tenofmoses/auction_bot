declare module 'node-telegram-bot-api' {
  export type Chat = {
    id: number | string;
    type: string;
  };

  export type Message = {
    chat: Chat;
    text?: string;
    from?: {
      id: number | string;
      username?: string;
    };
  };

  export type TelegramBotOptions = {
    polling?: boolean;
  };

  export type SendMessageOptions = {
    parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
    disable_web_page_preview?: boolean;
  };

  export default class TelegramBot {
    constructor(token: string, options?: TelegramBotOptions);
    on(event: 'message', listener: (msg: Message) => void | Promise<void>): void;
    sendMessage(chatId: number | string, text: string, options?: SendMessageOptions): Promise<unknown>;
  }
}
