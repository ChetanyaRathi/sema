#!/usr/bin/env guile
!#

(use-modules (ice-9 binary-ports)
             (ice-9 format)
             (rnrs bytevectors))

;; Byte-oriented implementation: read the whole file as one bytevector and
;; scan bytes directly — no per-line string decode, no substring for the
;; temperature. Only the station name is materialized per row (like the
;; Janet/Racket/Gauche entries). Temperatures are parsed as integer×10.

(define SEMI 59)   ; ;
(define NL 10)     ; \n
(define CR 13)     ; \r
(define DOT 46)    ; .
(define MINUS 45)  ; -

;; Copy bytes [start, end) into a fresh bytevector (R6RS bytevector-copy has
;; no range arguments).
(define (bv-slice bv start end)
  (let* ((n (- end start))
         (out (make-bytevector n)))
    (bytevector-copy! bv start out 0 n)
    out))

;; Format an integer×10 value as a decimal string: 123 → "12.3", -51 → "-5.1"
(define (format-temp n)
  (let* ((sign (if (negative? n) "-" ""))
         (a (abs n))
         (whole (quotient a 10))
         (frac (remainder a 10)))
    (string-append sign (number->string whole) "." (number->string frac))))

(define (main args)
  (when (< (length args) 2)
    (display "Usage: guile 1brc.scm <file>\n")
    (exit 1))

  (let* ((file-path (cadr args))
         (stations (make-hash-table 500))
         (start-time (get-internal-real-time))
         (data (call-with-input-file file-path get-bytevector-all #:binary #t))
         (len (bytevector-length data)))

    (define (accumulate name temp)
      (let ((entry (hash-ref stations name)))
        (if entry
            (begin
              (vector-set! entry 0 (min (vector-ref entry 0) temp))
              (vector-set! entry 1 (max (vector-ref entry 1) temp))
              (vector-set! entry 2 (+ (vector-ref entry 2) temp))
              (vector-set! entry 3 (+ (vector-ref entry 3) 1)))
            (hash-set! stations name (vector temp temp temp 1)))))

    ;; One pass over the bytes: name ';' temp '\n', row by row.
    (let row-loop ((i 0))
      (when (< i len)
        (let semi-loop ((j i))
          (cond
           ((>= j len) #f) ; trailing partial line without ';' — done
           ((= (bytevector-u8-ref data j) SEMI)
            (let* ((name (utf8->string (bv-slice data i j)))
                   (k0 (+ j 1))
                   (neg? (and (< k0 len) (= (bytevector-u8-ref data k0) MINUS))))
              (let temp-loop ((k (if neg? (+ k0 1) k0)) (acc 0))
                (if (>= k len)
                    (begin
                      (accumulate name (if neg? (- acc) acc))
                      (row-loop len))
                    (let ((b (bytevector-u8-ref data k)))
                      (cond
                       ((= b NL)
                        (accumulate name (if neg? (- acc) acc))
                        (row-loop (+ k 1)))
                       ((or (= b CR) (= b DOT)) (temp-loop (+ k 1) acc))
                       (else (temp-loop (+ k 1) (+ (* acc 10) (- b 48))))))))))
           (else (semi-loop (+ j 1)))))))

    ;; Collect and sort station names
    (let* ((names (sort (hash-map->list (lambda (k v) k) stations) string<?))
           (parts (map (lambda (name)
                         (let* ((entry (hash-ref stations name))
                                (mn (vector-ref entry 0))
                                (mx (vector-ref entry 1))
                                (sum (vector-ref entry 2))
                                (cnt (vector-ref entry 3))
                                (mean (inexact->exact (round (/ (* sum 1.0) cnt)))))
                           (string-append name "="
                                          (format-temp mn) "/"
                                          (format-temp mean) "/"
                                          (format-temp mx))))
                       names))
           (end-time (get-internal-real-time))
           (elapsed-ms (* 1000.0 (/ (- end-time start-time)
                                     internal-time-units-per-second))))

      (display "{")
      (display (string-join parts ", "))
      (display "}")
      (newline)

      (format #t "Elapsed: ~,1f ms~%" elapsed-ms))))

(main (command-line))
