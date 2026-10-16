// CloudFront Function (viewer-request): optional basic auth for the showcase.
// Only deployed when the `password` variable is set.
var CREDENTIAL = '${credential}';

function handler(event) {
  var auth = event.request.headers.authorization;
  if (!auth || auth.value !== 'Basic ' + CREDENTIAL) {
    return {
      statusCode: 401,
      statusDescription: 'Unauthorized',
      headers: { 'www-authenticate': { value: 'Basic realm="SmartChess", charset="UTF-8"' } },
    };
  }
  return event.request;
}
