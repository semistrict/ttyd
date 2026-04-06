#include <errno.h>
#include <json.h>
#include <libwebsockets.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef TTYD_OPENSSL_CRYPTO
#include <openssl/evp.h>
#include <openssl/rand.h>
#endif

#include "pty.h"
#include "server.h"
#include "utils.h"
#include "compat.h"

// initial message list
static char initial_cmds[] = {SET_WINDOW_TITLE, SET_PREFERENCES};

#ifdef TTYD_OPENSSL_CRYPTO
#define CONNECT_NONCE_LEN 12
#define CONNECT_TAG_LEN 16
#endif

static bool use_connect_shared_key(void) {
  return server->connect_url != NULL && server->connect_shared_key_enabled;
}

#ifdef TTYD_OPENSSL_CRYPTO
static int encrypt_connect_payload(const unsigned char *plaintext, size_t plaintext_len,
                                   unsigned char **ciphertext, size_t *ciphertext_len) {
  EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
  if (ctx == NULL) return -1;

  *ciphertext_len = CONNECT_NONCE_LEN + plaintext_len + CONNECT_TAG_LEN;
  *ciphertext = xmalloc(*ciphertext_len);
  unsigned char *nonce = *ciphertext;
  unsigned char *body = *ciphertext + CONNECT_NONCE_LEN;
  unsigned char *tag = *ciphertext + CONNECT_NONCE_LEN + plaintext_len;
  int out_len = 0;
  int final_len = 0;
  int ok = 0;

  if (RAND_bytes(nonce, CONNECT_NONCE_LEN) != 1) goto done;
  if (EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), NULL, NULL, NULL) != 1) goto done;
  if (EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, CONNECT_NONCE_LEN, NULL) != 1) goto done;
  if (EVP_EncryptInit_ex(ctx, NULL, NULL, server->connect_shared_key, nonce) != 1) goto done;
  if (plaintext_len > 0 &&
      EVP_EncryptUpdate(ctx, body, &out_len, plaintext, (int) plaintext_len) != 1) goto done;
  if (EVP_EncryptFinal_ex(ctx, body + out_len, &final_len) != 1) goto done;
  if (EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, CONNECT_TAG_LEN, tag) != 1) goto done;
  *ciphertext_len = CONNECT_NONCE_LEN + (size_t)(out_len + final_len) + CONNECT_TAG_LEN;
  ok = 1;

done:
  EVP_CIPHER_CTX_free(ctx);
  if (!ok) {
    free(*ciphertext);
    *ciphertext = NULL;
    *ciphertext_len = 0;
    return -1;
  }
  return 0;
}

static int decrypt_connect_payload(const unsigned char *ciphertext, size_t ciphertext_len,
                                   unsigned char **plaintext, size_t *plaintext_len) {
  if (ciphertext_len < CONNECT_NONCE_LEN + CONNECT_TAG_LEN) return -1;

  size_t body_len = ciphertext_len - CONNECT_NONCE_LEN - CONNECT_TAG_LEN;
  const unsigned char *nonce = ciphertext;
  const unsigned char *body = ciphertext + CONNECT_NONCE_LEN;
  const unsigned char *tag = ciphertext + CONNECT_NONCE_LEN + body_len;

  EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
  if (ctx == NULL) return -1;

  *plaintext = xmalloc(body_len > 0 ? body_len : 1);
  *plaintext_len = body_len;
  int out_len = 0;
  int final_len = 0;
  int ok = 0;

  if (EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), NULL, NULL, NULL) != 1) goto done;
  if (EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, CONNECT_NONCE_LEN, NULL) != 1) goto done;
  if (EVP_DecryptInit_ex(ctx, NULL, NULL, server->connect_shared_key, nonce) != 1) goto done;
  if (body_len > 0 && EVP_DecryptUpdate(ctx, *plaintext, &out_len, body, (int) body_len) != 1) goto done;
  if (EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, CONNECT_TAG_LEN, (void *) tag) != 1) goto done;
  if (EVP_DecryptFinal_ex(ctx, *plaintext + out_len, &final_len) != 1) goto done;
  *plaintext_len = (size_t)(out_len + final_len);
  ok = 1;

done:
  EVP_CIPHER_CTX_free(ctx);
  if (!ok) {
    free(*plaintext);
    *plaintext = NULL;
    *plaintext_len = 0;
    return -1;
  }
  return 0;
}
#endif

static int write_command_message(struct lws *wsi, char command, const unsigned char *payload, size_t payload_len) {
  unsigned char *encoded = (unsigned char *) payload;
  size_t encoded_len = payload_len;
#ifdef TTYD_OPENSSL_CRYPTO
  unsigned char *encrypted = NULL;
  if (use_connect_shared_key()) {
    if (encrypt_connect_payload(payload, payload_len, &encrypted, &encoded_len) != 0) {
      lwsl_err("failed to encrypt outbound payload\n");
      return -1;
    }
    encoded = encrypted;
  }
#endif

  unsigned char *message = xmalloc(LWS_PRE + 1 + encoded_len);
  unsigned char *ptr = message + LWS_PRE;
  ptr[0] = (unsigned char) command;
  if (encoded_len > 0) memcpy(ptr + 1, encoded, encoded_len);
  size_t n = 1 + encoded_len;
  int rc = lws_write(wsi, ptr, n, LWS_WRITE_BINARY);

  free(message);
#ifdef TTYD_OPENSSL_CRYPTO
  if (encrypted != NULL) free(encrypted);
#endif
  return rc < (int) n ? -1 : 0;
}

static int send_initial_message(struct lws *wsi, int index) {
  char buffer[4096];
  char hostname[128];
  const unsigned char *payload = NULL;
  size_t payload_len = 0;

  char cmd = initial_cmds[index];
  switch (cmd) {
    case SET_WINDOW_TITLE:
      gethostname(hostname, sizeof(hostname) - 1);
      hostname[sizeof(hostname) - 1] = '\0';
      snprintf(buffer, sizeof(buffer), "%s (%s)", server->command, hostname);
      payload = (const unsigned char *) buffer;
      payload_len = strlen(buffer);
      break;
    case SET_PREFERENCES:
      payload = (const unsigned char *) server->prefs_json;
      payload_len = strlen(server->prefs_json);
      break;
    default:
      break;
  }

  return write_command_message(wsi, cmd, payload, payload_len);
}

static json_object *parse_window_size(const char *buf, size_t len, uint16_t *cols, uint16_t *rows) {
  json_tokener *tok = json_tokener_new();
  json_object *obj = json_tokener_parse_ex(tok, buf, len);
  struct json_object *o = NULL;

  if (json_object_object_get_ex(obj, "columns", &o)) *cols = (uint16_t)json_object_get_int(o);
  if (json_object_object_get_ex(obj, "rows", &o)) *rows = (uint16_t)json_object_get_int(o);

  json_tokener_free(tok);
  return obj;
}

static bool check_host_origin(struct lws *wsi) {
  char buf[256];
  memset(buf, 0, sizeof(buf));
  int len = lws_hdr_copy(wsi, buf, (int)sizeof(buf), WSI_TOKEN_ORIGIN);
  if (len <= 0) return false;

  const char *prot, *address, *path;
  int port;
  if (lws_parse_uri(buf, &prot, &address, &port, &path)) return false;
  if (port == 80 || port == 443) {
    snprintf(buf, sizeof(buf), "%s", address);
  } else {
    snprintf(buf, sizeof(buf), "%s:%d", address, port);
  }

  char host_buf[256];
  memset(host_buf, 0, sizeof(host_buf));
  len = lws_hdr_copy(wsi, host_buf, (int)sizeof(host_buf), WSI_TOKEN_HOST);

  return len > 0 && strcasecmp(buf, host_buf) == 0;
}

static pty_ctx_t *pty_ctx_init(struct pss_tty *pss) {
  pty_ctx_t *ctx = xmalloc(sizeof(pty_ctx_t));
  ctx->pss = pss;
  ctx->ws_closed = false;
  return ctx;
}

static void pty_ctx_free(pty_ctx_t *ctx) { free(ctx); }

static void process_read_cb(pty_process *process, pty_buf_t *buf, bool eof) {
  pty_ctx_t *ctx = (pty_ctx_t *)process->ctx;
  if (ctx->ws_closed) {
    pty_buf_free(buf);
    return;
  }

  if (eof && !process_running(process))
    ctx->pss->lws_close_status = process->exit_code == 0 ? 1000 : 1006;
  else
    ctx->pss->pty_buf = buf;
  lws_callback_on_writable(ctx->pss->wsi);
}

static void process_exit_cb(pty_process *process) {
  pty_ctx_t *ctx = (pty_ctx_t *)process->ctx;
  if (ctx->ws_closed) {
    lwsl_notice("process killed with signal %d, pid: %d\n", process->exit_signal, process->pid);
    goto done;
  }

  lwsl_notice("process exited with code %d, pid: %d\n", process->exit_code, process->pid);
  ctx->pss->process = NULL;
  ctx->pss->lws_close_status = process->exit_code == 0 ? 1000 : 1006;
  lws_callback_on_writable(ctx->pss->wsi);

done:
  pty_ctx_free(ctx);

  // if we are going to exit, do it now.
  if (force_exit) exit(0);
}

static char **build_args(struct pss_tty *pss) {
  int i, n = 0;
  char **argv = xmalloc((server->argc + pss->argc + 1) * sizeof(char *));

  for (i = 0; i < server->argc; i++) {
    argv[n++] = server->argv[i];
  }

  for (i = 0; i < pss->argc; i++) {
    argv[n++] = pss->args[i];
  }

  argv[n] = NULL;

  return argv;
}

static char **build_env(struct pss_tty *pss) {
  int i = 0, n = 2;
  char **envp = xmalloc(n * sizeof(char *));

  // TERM
  envp[i] = xmalloc(36);
  snprintf(envp[i], 36, "TERM=%s", server->terminal_type);
  i++;

  // TTYD_USER
  if (strlen(pss->user) > 0) {
    envp = xrealloc(envp, (++n) * sizeof(char *));
    envp[i] = xmalloc(40);
    snprintf(envp[i], 40, "TTYD_USER=%s", pss->user);
    i++;
  }

  envp[i] = NULL;

  return envp;
}

static bool spawn_process(struct pss_tty *pss, uint16_t columns, uint16_t rows) {
  pty_process *process = process_init((void *)pty_ctx_init(pss), server->loop, build_args(pss), build_env(pss));
  if (server->cwd != NULL) process->cwd = strdup(server->cwd);
  if (columns > 0) process->columns = columns;
  if (rows > 0) process->rows = rows;
  if (pty_spawn(process, process_read_cb, process_exit_cb) != 0) {
    lwsl_err("pty_spawn: %d (%s)\n", errno, strerror(errno));
    process_free(process);
    return false;
  }
  lwsl_notice("started process, pid: %d\n", process->pid);
  pss->process = process;
  lws_callback_on_writable(pss->wsi);

  return true;
}

static void wsi_output(struct lws *wsi, pty_buf_t *buf) {
  if (buf == NULL) return;
  if (write_command_message(wsi, OUTPUT, (const unsigned char *) buf->base, buf->len) != 0) {
    lwsl_err("write OUTPUT to WS\n");
  }
}

static bool check_auth(struct lws *wsi, struct pss_tty *pss) {
  if (server->auth_header != NULL) {
    return lws_hdr_custom_copy(wsi, pss->user, sizeof(pss->user), server->auth_header, strlen(server->auth_header)) > 0;
  }

  if (server->credential != NULL) {
    char buf[256];
    size_t n = lws_hdr_copy(wsi, buf, sizeof(buf), WSI_TOKEN_HTTP_AUTHORIZATION);
    return n >= 7 && strstr(buf, "Basic ") && !strcmp(buf + 6, server->credential);
  }

  return true;
}

// --- shared helpers used by both server and client callbacks ---

static int handle_writeable(struct lws *wsi, struct pss_tty *pss) {
  if (!pss->initialized) {
    if (pss->initial_cmd_index == sizeof(initial_cmds)) {
      pss->initialized = true;
      pty_resume(pss->process);
      return 0;
    }
    if (send_initial_message(wsi, pss->initial_cmd_index) < 0) {
      lwsl_err("failed to send initial message, index: %d\n", pss->initial_cmd_index);
      lws_close_reason(wsi, LWS_CLOSE_STATUS_UNEXPECTED_CONDITION, NULL, 0);
      return -1;
    }
    pss->initial_cmd_index++;
    lws_callback_on_writable(wsi);
    return 0;
  }

  if (pss->lws_close_status > LWS_CLOSE_STATUS_NOSTATUS) {
    lws_close_reason(wsi, pss->lws_close_status, NULL, 0);
    return 1;
  }

  if (pss->pty_buf != NULL) {
    wsi_output(wsi, pss->pty_buf);
    pty_buf_free(pss->pty_buf);
    pss->pty_buf = NULL;
    pty_resume(pss->process);
  }
  return 0;
}

// Accumulate incoming data into pss->buffer. Returns true when the full message is ready.
static bool receive_append(struct pss_tty *pss, struct lws *wsi, void *in, size_t len) {
  if (pss->buffer == NULL) {
    pss->buffer = xmalloc(len);
    pss->len = len;
    memcpy(pss->buffer, in, len);
  } else {
    pss->buffer = xrealloc(pss->buffer, pss->len + len);
    memcpy(pss->buffer + pss->len, in, len);
    pss->len += len;
  }
  return !(lws_remaining_packet_payload(wsi) > 0 || !lws_is_final_fragment(wsi));
}

// Dispatch common commands (INPUT, RESIZE, PAUSE, RESUME).
// Returns: 0 = handled, 1 = unknown command, -1 = error.
static int handle_command(struct pss_tty *pss) {
  const char command = pss->buffer[0];
  const unsigned char *payload = (const unsigned char *)pss->buffer + 1;
  size_t payload_len = pss->len - 1;
#ifdef TTYD_OPENSSL_CRYPTO
  unsigned char *decrypted = NULL;
  if (use_connect_shared_key()) {
    if (decrypt_connect_payload(payload, payload_len, &decrypted, &payload_len) != 0) {
      lwsl_err("failed to decrypt inbound payload\n");
      return -1;
    }
    payload = decrypted;
  }
#endif
  int rc = 0;

  switch (command) {
    case INPUT:
      if (!server->writable) break;
      if (pss->process == NULL) break;
      {
        int err = pty_write(pss->process, pty_buf_init((char *) payload, payload_len));
        if (err) {
          lwsl_err("uv_write: %s (%s)\n", uv_err_name(err), uv_strerror(err));
          rc = -1;
          break;
        }
      }
      break;
    case RESIZE_TERMINAL:
      if (pss->process == NULL) break;
      json_object_put(
          parse_window_size((const char *) payload, payload_len, &pss->process->columns, &pss->process->rows));
      pty_resize(pss->process);
      break;
    case PAUSE:
      if (pss->process != NULL) pty_pause(pss->process);
      break;
    case RESUME:
      if (pss->process != NULL) pty_resume(pss->process);
      break;
    default:
      rc = 1;
      break;
  }

#ifdef TTYD_OPENSSL_CRYPTO
  if (decrypted != NULL) free(decrypted);
#endif
  return rc;
}

static void receive_cleanup(struct pss_tty *pss) {
  if (pss->buffer != NULL) {
    free(pss->buffer);
    pss->buffer = NULL;
  }
}

static void handle_close(struct pss_tty *pss) {
  if (pss->buffer != NULL) free(pss->buffer);
  if (pss->pty_buf != NULL) pty_buf_free(pss->pty_buf);

  if (pss->process != NULL) {
    ((pty_ctx_t *)pss->process->ctx)->ws_closed = true;
    if (process_running(pss->process)) {
      pty_pause(pss->process);
      lwsl_notice("killing process, pid: %d\n", pss->process->pid);
      pty_kill(pss->process, server->sig_code);
    }
  }
}

int callback_tty(struct lws *wsi, enum lws_callback_reasons reason, void *user, void *in, size_t len) {
  struct pss_tty *pss = (struct pss_tty *)user;
  char buf[256];
  size_t n = 0;

  switch (reason) {
    case LWS_CALLBACK_FILTER_PROTOCOL_CONNECTION:
      if (server->once && server->client_count > 0) {
        lwsl_warn("refuse to serve WS client due to the --once option.\n");
        return 1;
      }
      if (server->max_clients > 0 && server->client_count == server->max_clients) {
        lwsl_warn("refuse to serve WS client due to the --max-clients option.\n");
        return 1;
      }
      if (!check_auth(wsi, pss)) return 1;

      n = lws_hdr_copy(wsi, pss->path, sizeof(pss->path), WSI_TOKEN_GET_URI);
#if defined(LWS_ROLE_H2)
      if (n <= 0) n = lws_hdr_copy(wsi, pss->path, sizeof(pss->path), WSI_TOKEN_HTTP_COLON_PATH);
#endif
      if (strncmp(pss->path, endpoints.ws, n) != 0) {
        lwsl_warn("refuse to serve WS client for illegal ws path: %s\n", pss->path);
        return 1;
      }

      if (server->check_origin && !check_host_origin(wsi)) {
        lwsl_warn(
            "refuse to serve WS client from different origin due to the "
            "--check-origin option.\n");
        return 1;
      }
      break;

    case LWS_CALLBACK_ESTABLISHED:
      pss->initialized = false;
      pss->authenticated = false;
      pss->wsi = wsi;
      pss->lws_close_status = LWS_CLOSE_STATUS_NOSTATUS;

      if (server->url_arg) {
        while (lws_hdr_copy_fragment(wsi, buf, sizeof(buf), WSI_TOKEN_HTTP_URI_ARGS, n++) > 0) {
          if (strncmp(buf, "arg=", 4) == 0) {
            pss->args = xrealloc(pss->args, (pss->argc + 1) * sizeof(char *));
            pss->args[pss->argc] = strdup(&buf[4]);
            pss->argc++;
          }
        }
      }

      server->client_count++;

      lws_get_peer_simple(lws_get_network_wsi(wsi), pss->address, sizeof(pss->address));
      lwsl_notice("WS   %s - %s, clients: %d\n", pss->path, pss->address, server->client_count);
      break;

    case LWS_CALLBACK_SERVER_WRITEABLE: {
      int rc = handle_writeable(wsi, pss);
      if (rc != 0) return rc;
      break;
    }

    case LWS_CALLBACK_RECEIVE:
      if (!receive_append(pss, wsi, in, len)) return 0;

      // check auth
      if (server->credential != NULL && !pss->authenticated && pss->buffer[0] != JSON_DATA) {
        lwsl_warn("WS client not authenticated\n");
        return 1;
      }

      {
        int rc = handle_command(pss);
        if (rc == -1) return -1;
        if (rc == 1) {
          // not a common command — handle JSON_DATA (initial handshake) or warn
          if (pss->buffer[0] == JSON_DATA) {
            if (pss->process != NULL) goto recv_done;
            uint16_t columns = 0;
            uint16_t rows = 0;
            json_object *obj = parse_window_size(pss->buffer, pss->len, &columns, &rows);
            if (server->credential != NULL) {
              struct json_object *o = NULL;
              if (json_object_object_get_ex(obj, "AuthToken", &o)) {
                const char *token = json_object_get_string(o);
                if (token != NULL && !strcmp(token, server->credential))
                  pss->authenticated = true;
                else
                  lwsl_warn("WS authentication failed with token: %s\n", token);
              }
              if (!pss->authenticated) {
                json_object_put(obj);
                lws_close_reason(wsi, LWS_CLOSE_STATUS_POLICY_VIOLATION, NULL, 0);
                return -1;
              }
            }
            json_object_put(obj);
            if (!spawn_process(pss, columns, rows)) return 1;
          } else {
            lwsl_warn("ignored unknown message type: %c\n", pss->buffer[0]);
          }
        }
      }

recv_done:
      receive_cleanup(pss);
      break;

    case LWS_CALLBACK_CLOSED:
      if (pss->wsi == NULL) break;

      server->client_count--;
      lwsl_notice("WS closed from %s, clients: %d\n", pss->address, server->client_count);

      handle_close(pss);
      for (int i = 0; i < pss->argc; i++) {
        free(pss->args[i]);
      }

      if ((server->once || server->exit_no_conn) && server->client_count == 0) {
        lwsl_notice("exiting due to the --once/--exit-no-conn option.\n");

        // stop accepting new ws connections
        lws_cancel_service(context);

        if (process_running(pss->process)) {
          force_exit = true;
          lwsl_notice("send ^C to force exit.\n");
        } else {
          exit(0);
        }
      }
      break;

    default:
      break;
  }

  return 0;
}

int callback_tty_client(struct lws *wsi, enum lws_callback_reasons reason, void *user, void *in, size_t len) {
  struct pss_tty *pss = (struct pss_tty *)user;

  switch (reason) {
    case LWS_CALLBACK_CLIENT_ESTABLISHED:
      lwsl_notice("WS client connected to %s\n", server->connect_url);
      pss->authenticated = true;
      pss->wsi = wsi;
      pss->lws_close_status = LWS_CLOSE_STATUS_NOSTATUS;

      if (!spawn_process(pss, 80, 24)) return -1;
      break;

    case LWS_CALLBACK_CLIENT_WRITEABLE: {
      int rc = handle_writeable(wsi, pss);
      if (rc != 0) return rc;
      break;
    }

    case LWS_CALLBACK_CLIENT_RECEIVE:
      if (!receive_append(pss, wsi, in, len)) return 0;

      {
        int rc = handle_command(pss);
        if (rc == -1) return -1;
        if (rc == 1) lwsl_warn("ignored unknown message type: %c\n", pss->buffer[0]);
      }

      receive_cleanup(pss);
      break;

    case LWS_CALLBACK_CLOSED:
      lwsl_notice("WS client connection closed\n");
      handle_close(pss);
      force_exit = true;
      lws_cancel_service(context);
      uv_stop(server->loop);
      break;

    case LWS_CALLBACK_CLIENT_CONNECTION_ERROR:
      lwsl_err("WS client connection error: %s\n", in ? (char *)in : "(null)");
      force_exit = true;
      lws_cancel_service(context);
      uv_stop(server->loop);
      break;

    default:
      break;
  }

  return 0;
}
