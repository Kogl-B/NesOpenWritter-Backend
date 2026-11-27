export class AiHttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'AiHttpError';
    this.statusCode = statusCode;
  }
}
