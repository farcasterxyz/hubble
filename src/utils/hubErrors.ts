import { Result } from 'neverthrow';

interface HubErrorOpts {
  message: string;
  cause: Error | HubError;
  presentable: boolean;
}

/**
 * HubError should be used to construct all types exceptions in the Hub.
 *
 * A HubError is instantiated with a HubErrorCode that classifies the error, a context object that
 * provides additional information about the error. The context object can be a string, an Error,
 * or both and also accepts additional parameters to classify the HubError. HubErrors should never
 * be thrown directly and always be returned using neverthrow's Result type.
 */
export class HubError extends Error {
  /* Hub classification of error types */
  public readonly errCode: HubErrorCode;

  /* Indicates if if error message can be presented to the user */
  public readonly presentable: boolean = false;

  /**
   * @param errCode - the HubError code for this message
   * @param context - a message, another Error, or a HubErrorOpts
   */
  constructor(errCode: HubErrorCode, context: Partial<HubErrorOpts> | string | Error) {
    if (typeof context === 'string') {
      context = { message: context };
    } else if (context instanceof Error) {
      context = { cause: context, message: context.message };
    }

    if (!context.message) {
      context.message = context.cause?.message || '';
    }

    super(context.message, { cause: context.cause });

    this.name = 'HubError';
    this.errCode = errCode;
  }
}

/**
 * HubErrorCode defines all the types of errors that can be raised in the Hub.
 *
 * A string union type is chosen over an enumeration since TS enums are unusual types that generate
 * javascript code and may cause downstream issues. See:
 * https://www.executeprogram.com/blog/typescript-features-to-avoid
 */
type HubErrorCode =
  /* The request did not have valid authentication credentials, retry with credentials  */
  | 'unauthenticated'
  /* The authenticated request did not have the authority to perform this action  */
  | 'unauthorized'
  /* The request cannot be completed as constructed, do not retry */
  | 'bad_request'
  | 'bad_request.parse_failure'
  | 'bad_request.invalid_param'
  | 'bad_request.validation_failure'
  /* The requested resource could not be found */
  | 'not_found'
  /* The request could not be completed, it may or may not be safe to retry */
  | 'unavailable'
  | 'unavailable.network_failure'
  | 'unavailable.storage_failure'
  /* An unknown error was encountered */
  | 'unknown';

/** Type alias for shorthand when handling errors */
export type HubResult<T> = Result<T, HubError>;
