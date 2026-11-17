// Keep the process isolated from credential helpers and code injection while
// retaining the Host's existing network route and certificate trust selectors.
// Preserve exact key spelling/value: proxy precedence is case-sensitive on
// POSIX, while Windows supplies case-insensitive environment keys.
const inheritedEnvironment = /^(?:PATH|PATHEXT|SystemRoot|SystemDrive|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|LANG|LC_ALL|LC_CTYPE|TZ|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|GIT_SSL_CAINFO|GIT_SSL_CAPATH|GIT_PROXY_SSL_CAINFO|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE)$/i
export function gitRuntimeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => inheritedEnvironment.test(key)))
}
