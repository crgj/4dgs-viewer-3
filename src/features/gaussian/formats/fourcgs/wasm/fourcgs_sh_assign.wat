(module
  ;; #WDD-gpt 2026-08-16 - 将 SH 产品树标签与误差扫描放入确定性的 WASM f64 热循环，供多片段 Worker 并行执行。
  (memory (export "memory") 1 16384)
  (global $heap (mut i32) (i32.const 8))

  (func (export "reset")
    (global.set $heap (i32.const 8))
  )

  (func (export "alloc") (param $size i32) (result i32)
    (local $start i32)
    (local $end i32)
    (local $required i32)
    (local.set $start (global.get $heap))
    (local.set $end
      (i32.and
        (i32.add (local.get $start) (i32.add (local.get $size) (i32.const 7)))
        (i32.const -8)
      )
    )
    (if (i32.gt_u (local.get $end) (i32.shl (memory.size) (i32.const 16)))
      (then
        (local.set $required
          (i32.sub
            (i32.shr_u (i32.add (local.get $end) (i32.const 65535)) (i32.const 16))
            (memory.size)
          )
        )
        (if (i32.eq (memory.grow (local.get $required)) (i32.const -1))
          (then unreachable)
        )
      )
    )
    (global.set $heap (local.get $end))
    (local.get $start)
  )

  (func $half_to_f64 (param $bits i32) (result f64)
    (local $sign i32)
    (local $exponent i32)
    (local $mantissa i32)
    (local $float_bits i32)
    (local.set $sign (i32.and (i32.shr_u (local.get $bits) (i32.const 15)) (i32.const 1)))
    (local.set $exponent (i32.and (i32.shr_u (local.get $bits) (i32.const 10)) (i32.const 31)))
    (local.set $mantissa (i32.and (local.get $bits) (i32.const 1023)))
    (if (i32.eqz (local.get $exponent))
      (then
        (if (i32.eqz (local.get $mantissa))
          (then
            (local.set $float_bits (i32.shl (local.get $sign) (i32.const 31)))
          )
          (else
            (local.set $exponent (i32.const -14))
            (block $normalized
              (loop $normalize
                (br_if $normalized (i32.ne (i32.and (local.get $mantissa) (i32.const 1024)) (i32.const 0)))
                (local.set $mantissa (i32.shl (local.get $mantissa) (i32.const 1)))
                (local.set $exponent (i32.sub (local.get $exponent) (i32.const 1)))
                (br $normalize)
              )
            )
            (local.set $mantissa (i32.and (local.get $mantissa) (i32.const 1023)))
            (local.set $float_bits
              (i32.or
                (i32.shl (local.get $sign) (i32.const 31))
                (i32.or
                  (i32.shl (i32.add (local.get $exponent) (i32.const 127)) (i32.const 23))
                  (i32.shl (local.get $mantissa) (i32.const 13))
                )
              )
            )
          )
        )
      )
      (else
        (if (i32.eq (local.get $exponent) (i32.const 31))
          (then
            (local.set $float_bits
              (i32.or
                (i32.shl (local.get $sign) (i32.const 31))
                (i32.or (i32.const 2139095040) (i32.shl (local.get $mantissa) (i32.const 13)))
              )
            )
          )
          (else
            (local.set $float_bits
              (i32.or
                (i32.shl (local.get $sign) (i32.const 31))
                (i32.or
                  (i32.shl (i32.add (local.get $exponent) (i32.const 112)) (i32.const 23))
                  (i32.shl (local.get $mantissa) (i32.const 13))
                )
              )
            )
          )
        )
      )
    )
    (f64.promote_f32 (f32.reinterpret_i32 (local.get $float_bits)))
  )

  (func (export "assign_sh")
    (param $rows i32)
    (param $row_count i32)
    (param $row_stride i32)
    (param $sh_indices i32)
    (param $level_dimensions i32)
    (param $dimension_counts i32)
    (param $node_splits i32)
    (param $centers i32)
    (param $level_count i32)
    (param $maximum_dimensions i32)
    (param $labels i32)
    (param $squared_errors i32)
    (param $maximum_errors i32)
    (local $row i32)
    (local $level i32)
    (local $component i32)
    (local $dimension_count i32)
    (local $dimension i32)
    (local $property i32)
    (local $node i32)
    (local $label i32)
    (local $split_offset i32)
    (local $center_offset i32)
    (local $value f64)
    (local $difference f64)
    (local $left_distance f64)
    (local $right_distance f64)
    (local $squared_error f64)
    (local $maximum_error f64)

    (local.set $row (i32.const 0))
    (block $rows_done
      (loop $rows_loop
        (br_if $rows_done (i32.ge_u (local.get $row) (local.get $row_count)))
        (local.set $squared_error (f64.const 0))
        (local.set $maximum_error (f64.const 0))
        (local.set $level (i32.const 0))
        (block $levels_done
          (loop $levels_loop
            (br_if $levels_done (i32.ge_u (local.get $level) (local.get $level_count)))
            (local.set $dimension_count
              (i32.load
                (i32.add (local.get $dimension_counts) (i32.shl (local.get $level) (i32.const 2)))))
            (local.set $node (i32.const 0))
            (block $tree_done
              (loop $tree_loop
                (br_if $tree_done (i32.ge_u (local.get $node) (i32.const 255)))
                (local.set $left_distance (f64.const 0))
                (local.set $right_distance (f64.const 0))
                (local.set $component (i32.const 0))
                (block $distance_done
                  (loop $distance_loop
                    (br_if $distance_done (i32.ge_u (local.get $component) (local.get $dimension_count)))
                    (local.set $dimension
                      (i32.load
                        (i32.add
                          (local.get $level_dimensions)
                          (i32.shl
                            (i32.add
                              (i32.mul (local.get $level) (local.get $maximum_dimensions))
                              (local.get $component))
                            (i32.const 2)))))
                    (local.set $property
                      (i32.load (i32.add (local.get $sh_indices) (i32.shl (local.get $dimension) (i32.const 2)))))
                    (local.set $value
                      (call $half_to_f64
                        (i32.load16_u
                          (i32.add
                            (local.get $rows)
                            (i32.shl
                              (i32.add
                                (i32.mul (local.get $row) (local.get $row_stride))
                                (local.get $property))
                              (i32.const 1))))))
                    (local.set $split_offset
                      (i32.add
                        (local.get $node_splits)
                        (i32.shl
                          (i32.add
                            (i32.mul
                              (i32.add
                                (i32.mul
                                  (i32.add (i32.mul (local.get $level) (i32.const 255)) (local.get $node))
                                  (i32.const 2))
                                (i32.const 0))
                              (local.get $maximum_dimensions))
                            (local.get $component))
                          (i32.const 2))))
                    (local.set $difference
                      (f64.sub
                        (local.get $value)
                        (f64.promote_f32 (f32.load (local.get $split_offset)))))
                    (local.set $left_distance
                      (f64.add (local.get $left_distance) (f64.mul (local.get $difference) (local.get $difference))))
                    (local.set $split_offset
                      (i32.add (local.get $split_offset) (i32.shl (local.get $maximum_dimensions) (i32.const 2))))
                    (local.set $difference
                      (f64.sub
                        (local.get $value)
                        (f64.promote_f32 (f32.load (local.get $split_offset)))))
                    (local.set $right_distance
                      (f64.add (local.get $right_distance) (f64.mul (local.get $difference) (local.get $difference))))
                    (local.set $component (i32.add (local.get $component) (i32.const 1)))
                    (br $distance_loop)
                  )
                )
                (if (f64.le (local.get $left_distance) (local.get $right_distance))
                  (then (local.set $node (i32.add (i32.mul (local.get $node) (i32.const 2)) (i32.const 1))))
                  (else (local.set $node (i32.add (i32.mul (local.get $node) (i32.const 2)) (i32.const 2)))))
                (br $tree_loop)
              )
            )
            (local.set $label (i32.sub (local.get $node) (i32.const 255)))
            (i32.store8
              (i32.add
                (local.get $labels)
                (i32.add (i32.mul (local.get $row) (local.get $level_count)) (local.get $level)))
              (local.get $label))
            (local.set $component (i32.const 0))
            (block $error_done
              (loop $error_loop
                (br_if $error_done (i32.ge_u (local.get $component) (local.get $dimension_count)))
                (local.set $dimension
                  (i32.load
                    (i32.add
                      (local.get $level_dimensions)
                      (i32.shl
                        (i32.add
                          (i32.mul (local.get $level) (local.get $maximum_dimensions))
                          (local.get $component))
                        (i32.const 2)))))
                (local.set $property
                  (i32.load (i32.add (local.get $sh_indices) (i32.shl (local.get $dimension) (i32.const 2)))))
                (local.set $value
                  (call $half_to_f64
                    (i32.load16_u
                      (i32.add
                        (local.get $rows)
                        (i32.shl
                          (i32.add
                            (i32.mul (local.get $row) (local.get $row_stride))
                            (local.get $property))
                          (i32.const 1))))))
                (local.set $center_offset
                  (i32.add
                    (local.get $centers)
                    (i32.shl
                      (i32.add
                        (i32.mul
                          (i32.add (i32.mul (local.get $level) (i32.const 256)) (local.get $label))
                          (local.get $maximum_dimensions))
                        (local.get $component))
                      (i32.const 2))))
                (local.set $difference
                  (f64.sub (local.get $value) (f64.promote_f32 (f32.load (local.get $center_offset)))))
                (local.set $squared_error
                  (f64.add (local.get $squared_error) (f64.mul (local.get $difference) (local.get $difference))))
                (local.set $maximum_error (f64.max (local.get $maximum_error) (f64.abs (local.get $difference))))
                (local.set $component (i32.add (local.get $component) (i32.const 1)))
                (br $error_loop)
              )
            )
            (local.set $level (i32.add (local.get $level) (i32.const 1)))
            (br $levels_loop)
          )
        )
        (f64.store
          (i32.add (local.get $squared_errors) (i32.shl (local.get $row) (i32.const 3)))
          (local.get $squared_error))
        (f32.store
          (i32.add (local.get $maximum_errors) (i32.shl (local.get $row) (i32.const 2)))
          (f32.demote_f64 (local.get $maximum_error)))
        (local.set $row (i32.add (local.get $row) (i32.const 1)))
        (br $rows_loop)
      )
    )
  )
)
