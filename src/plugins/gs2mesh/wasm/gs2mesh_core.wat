(module
  ;; #WDD-gpt 2026-08-15 - Move Census and bidirectional stereo matching into the browser WASM core.
  (memory (export "memory") 32 1024)
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

  (func (export "census")
    (param $gray i32)
    (param $output i32)
    (param $width i32)
    (param $height i32)
    (local $x i32)
    (local $y i32)
    (local $dx i32)
    (local $dy i32)
    (local $center i32)
    (local $descriptor i32)
    (local $bit i32)

    (memory.fill (local.get $output) (i32.const 0)
      (i32.shl (i32.mul (local.get $width) (local.get $height)) (i32.const 2)))
    (local.set $y (i32.const 2))
    (block $done_y
      (loop $loop_y
        (br_if $done_y (i32.ge_s (local.get $y) (i32.sub (local.get $height) (i32.const 2))))
        (local.set $x (i32.const 2))
        (block $done_x
          (loop $loop_x
            (br_if $done_x (i32.ge_s (local.get $x) (i32.sub (local.get $width) (i32.const 2))))
            (local.set $center
              (i32.load8_u
                (i32.add (local.get $gray)
                  (i32.add (i32.mul (local.get $y) (local.get $width)) (local.get $x)))))
            (local.set $descriptor (i32.const 0))
            (local.set $bit (i32.const 0))
            (local.set $dy (i32.const -2))
            (block $done_dy
              (loop $loop_dy
                (br_if $done_dy (i32.gt_s (local.get $dy) (i32.const 2)))
                (local.set $dx (i32.const -2))
                (block $done_dx
                  (loop $loop_dx
                    (br_if $done_dx (i32.gt_s (local.get $dx) (i32.const 2)))
                    (if
                      (i32.or
                        (i32.ne (local.get $dx) (i32.const 0))
                        (i32.ne (local.get $dy) (i32.const 0)))
                      (then
                        (if
                          (i32.lt_u
                            (i32.load8_u
                              (i32.add (local.get $gray)
                                (i32.add
                                  (i32.mul (i32.add (local.get $y) (local.get $dy)) (local.get $width))
                                  (i32.add (local.get $x) (local.get $dx)))))
                            (local.get $center))
                          (then
                            (local.set $descriptor
                              (i32.or (local.get $descriptor)
                                (i32.shl (i32.const 1) (local.get $bit))))
                          )
                        )
                        (local.set $bit (i32.add (local.get $bit) (i32.const 1)))
                      )
                    )
                    (local.set $dx (i32.add (local.get $dx) (i32.const 1)))
                    (br $loop_dx)
                  )
                )
                (local.set $dy (i32.add (local.get $dy) (i32.const 1)))
                (br $loop_dy)
              )
            )
            (i32.store
              (i32.add (local.get $output)
                (i32.shl
                  (i32.add (i32.mul (local.get $y) (local.get $width)) (local.get $x))
                  (i32.const 2)))
              (local.get $descriptor))
            (local.set $x (i32.add (local.get $x) (i32.const 1)))
            (br $loop_x)
          )
        )
        (local.set $y (i32.add (local.get $y) (i32.const 1)))
        (br $loop_y)
      )
    )
  )

  (func $match
    (param $source i32)
    (param $target i32)
    (param $width i32)
    (param $height i32)
    (param $x i32)
    (param $y i32)
    (param $direction i32)
    (param $minimum i32)
    (param $maximum i32)
    (result i32)
    (local $disparity i32)
    (local $target_x i32)
    (local $dy i32)
    (local $cost i32)
    (local $best i32)
    (local $second i32)
    (local $best_disparity i32)
    (local $source_offset i32)
    (local $target_offset i32)

    (local.set $best (i32.const 2147483647))
    (local.set $second (i32.const 2147483647))
    (local.set $best_disparity (i32.const 0))
    (local.set $disparity (local.get $minimum))
    (block $done
      (loop $search
        (br_if $done (i32.gt_s (local.get $disparity) (local.get $maximum)))
        (local.set $target_x
          (i32.add (local.get $x) (i32.mul (local.get $direction) (local.get $disparity))))
        (if
          (i32.and
            (i32.ge_s (local.get $target_x) (i32.const 3))
            (i32.lt_s (local.get $target_x) (i32.sub (local.get $width) (i32.const 3))))
          (then
            (local.set $cost (i32.const 0))
            (local.set $dy (i32.const -1))
            (block $done_dy
              (loop $cost_y
                (br_if $done_dy (i32.gt_s (local.get $dy) (i32.const 1)))
                (local.set $source_offset
                  (i32.shl
                    (i32.add
                      (i32.mul (i32.add (local.get $y) (local.get $dy)) (local.get $width))
                      (local.get $x))
                    (i32.const 2)))
                (local.set $target_offset
                  (i32.shl
                    (i32.add
                      (i32.mul (i32.add (local.get $y) (local.get $dy)) (local.get $width))
                      (local.get $target_x))
                    (i32.const 2)))
                (local.set $cost
                  (i32.add (local.get $cost)
                    (i32.popcnt
                      (i32.xor
                        (i32.load (i32.add (local.get $source) (local.get $source_offset)))
                        (i32.load (i32.add (local.get $target) (local.get $target_offset)))))))
                (local.set $dy (i32.add (local.get $dy) (i32.const 1)))
                (br $cost_y)
              )
            )
            (if (i32.lt_s (local.get $cost) (local.get $best))
              (then
                (local.set $second (local.get $best))
                (local.set $best (local.get $cost))
                (local.set $best_disparity (local.get $disparity))
              )
              (else
                (if (i32.lt_s (local.get $cost) (local.get $second))
                  (then (local.set $second (local.get $cost)))
                )
              )
            )
          )
        )
        (local.set $disparity (i32.add (local.get $disparity) (i32.const 1)))
        (br $search)
      )
    )
    (if (result i32)
      ;; #WDD-gpt 2026-08-15 - Slightly widen valid matches; the frontend refinement and Gaussian surface prior remove isolated errors.
      (i32.and
        (i32.le_s (local.get $best) (i32.const 52))
        (i32.ge_s (i32.sub (local.get $second) (local.get $best)) (i32.const 1)))
      (then (local.get $best_disparity))
      (else (i32.const 0))
    )
  )

  (func (export "stereo_match_grid")
    (param $left i32)
    (param $right i32)
    (param $foreground i32)
    (param $width i32)
    (param $height i32)
    (param $x_start i32)
    (param $y_start i32)
    (param $step i32)
    (param $columns i32)
    (param $rows i32)
    (param $minimum i32)
    (param $maximum i32)
    (param $output i32)
    (local $column i32)
    (local $row i32)
    (local $x i32)
    (local $y i32)
    (local $disparity i32)
    (local $reverse i32)
    (local $difference i32)
    (local $output_index i32)

    (memory.fill (local.get $output) (i32.const 0)
      (i32.shl (i32.mul (local.get $columns) (local.get $rows)) (i32.const 1)))
    (local.set $row (i32.const 0))
    (block $done_rows
      (loop $loop_rows
        (br_if $done_rows (i32.ge_s (local.get $row) (local.get $rows)))
        (local.set $y (i32.add (local.get $y_start) (i32.mul (local.get $row) (local.get $step))))
        (local.set $column (i32.const 0))
        (block $done_columns
          (loop $loop_columns
            (br_if $done_columns (i32.ge_s (local.get $column) (local.get $columns)))
            (local.set $x (i32.add (local.get $x_start) (i32.mul (local.get $column) (local.get $step))))
            (local.set $output_index
              (i32.add (i32.mul (local.get $row) (local.get $columns)) (local.get $column)))
            (if
              (i32.ne
                (i32.load8_u
                  (i32.add (local.get $foreground)
                    (i32.add (i32.mul (local.get $y) (local.get $width)) (local.get $x))))
                (i32.const 0))
              (then
                (local.set $disparity
                  (call $match
                    (local.get $left) (local.get $right)
                    (local.get $width) (local.get $height)
                    (local.get $x) (local.get $y) (i32.const -1)
                    (local.get $minimum) (local.get $maximum)))
                (if (i32.gt_s (local.get $disparity) (i32.const 0))
                  (then
                    (local.set $reverse
                      (call $match
                        (local.get $right) (local.get $left)
                        (local.get $width) (local.get $height)
                        (i32.sub (local.get $x) (local.get $disparity))
                        (local.get $y) (i32.const 1)
                        (local.get $minimum) (local.get $maximum)))
                    (local.set $difference (i32.sub (local.get $reverse) (local.get $disparity)))
                    (if (i32.lt_s (local.get $difference) (i32.const 0))
                      (then (local.set $difference (i32.sub (i32.const 0) (local.get $difference)))))
                    (if (i32.le_s (local.get $difference) (i32.const 2))
                      (then
                        (i32.store16
                          (i32.add (local.get $output) (i32.shl (local.get $output_index) (i32.const 1)))
                          (local.get $disparity))))
                  )
                )
              )
            )
            (local.set $column (i32.add (local.get $column) (i32.const 1)))
            (br $loop_columns)
          )
        )
        (local.set $row (i32.add (local.get $row) (i32.const 1)))
        (br $loop_rows)
      )
    )
  )

  ;; #WDD-gpt 2026-08-15 - Directly accumulate anisotropic Gaussian opacity into a browser WASM field for mesh extraction.
  (func (export "opacity_splat")
    (param $field i32)
    (param $best i32)
    (param $winner i32)
    (param $dim_x i32)
    (param $dim_y i32)
    (param $min_x i32)
    (param $max_x i32)
    (param $min_y i32)
    (param $max_y i32)
    (param $min_z i32)
    (param $max_z i32)
    (param $center_x f32)
    (param $center_y f32)
    (param $center_z f32)
    (param $a00 f32)
    (param $a01 f32)
    (param $a02 f32)
    (param $a10 f32)
    (param $a11 f32)
    (param $a12 f32)
    (param $a20 f32)
    (param $a21 f32)
    (param $a22 f32)
    (param $opacity f32)
    (param $gaussian_id i32)
    (local $x i32)
    (local $y i32)
    (local $z i32)
    (local $offset i32)
    (local $dx f32)
    (local $dy f32)
    (local $dz f32)
    (local $lx f32)
    (local $ly f32)
    (local $lz f32)
    (local $radius_squared f32)
    (local $kernel f32)
    (local $contribution f32)
    (local $previous f32)

    (local.set $z (local.get $min_z))
    (block $done_z
      (loop $loop_z
        (br_if $done_z (i32.gt_s (local.get $z) (local.get $max_z)))
        (local.set $dz (f32.sub (f32.convert_i32_s (local.get $z)) (local.get $center_z)))
        (local.set $y (local.get $min_y))
        (block $done_y
          (loop $loop_y
            (br_if $done_y (i32.gt_s (local.get $y) (local.get $max_y)))
            (local.set $dy (f32.sub (f32.convert_i32_s (local.get $y)) (local.get $center_y)))
            (local.set $x (local.get $min_x))
            (block $done_x
              (loop $loop_x
                (br_if $done_x (i32.gt_s (local.get $x) (local.get $max_x)))
                (local.set $dx (f32.sub (f32.convert_i32_s (local.get $x)) (local.get $center_x)))
                (local.set $lx
                  (f32.add
                    (f32.add
                      (f32.mul (local.get $a00) (local.get $dx))
                      (f32.mul (local.get $a01) (local.get $dy)))
                    (f32.mul (local.get $a02) (local.get $dz))))
                (local.set $ly
                  (f32.add
                    (f32.add
                      (f32.mul (local.get $a10) (local.get $dx))
                      (f32.mul (local.get $a11) (local.get $dy)))
                    (f32.mul (local.get $a12) (local.get $dz))))
                (local.set $lz
                  (f32.add
                    (f32.add
                      (f32.mul (local.get $a20) (local.get $dx))
                      (f32.mul (local.get $a21) (local.get $dy)))
                    (f32.mul (local.get $a22) (local.get $dz))))
                (local.set $radius_squared
                  (f32.add
                    (f32.add
                      (f32.mul (local.get $lx) (local.get $lx))
                      (f32.mul (local.get $ly) (local.get $ly)))
                    (f32.mul (local.get $lz) (local.get $lz))))
                (if (f32.lt (local.get $radius_squared) (f32.const 9))
                  (then
                    ;; Compact cubic kernel approximates the Gaussian three-sigma support without importing a slow JS exp call.
                    (local.set $kernel
                      (f32.sub (f32.const 1) (f32.div (local.get $radius_squared) (f32.const 9))))
                    (local.set $contribution
                      (f32.mul (local.get $opacity)
                        (f32.mul (local.get $kernel)
                          (f32.mul (local.get $kernel) (local.get $kernel)))))
                    (local.set $offset
                      (i32.shl
                        (i32.add
                          (i32.mul
                            (i32.add
                              (i32.mul (local.get $z) (local.get $dim_y))
                              (local.get $y))
                            (local.get $dim_x))
                          (local.get $x))
                        (i32.const 2)))
                    (local.set $previous (f32.load (i32.add (local.get $field) (local.get $offset))))
                    (f32.store
                      (i32.add (local.get $field) (local.get $offset))
                      (f32.min (f32.const 1)
                        (f32.sub (f32.const 1)
                          (f32.mul
                            (f32.sub (f32.const 1) (local.get $previous))
                            (f32.sub (f32.const 1) (local.get $contribution))))))
                    (if
                      (f32.gt
                        (local.get $contribution)
                        (f32.load (i32.add (local.get $best) (local.get $offset))))
                      (then
                        (f32.store
                          (i32.add (local.get $best) (local.get $offset))
                          (local.get $contribution))
                        (i32.store
                          (i32.add (local.get $winner) (local.get $offset))
                          (local.get $gaussian_id))))
                  )
                )
                (local.set $x (i32.add (local.get $x) (i32.const 1)))
                (br $loop_x)
              )
            )
            (local.set $y (i32.add (local.get $y) (i32.const 1)))
            (br $loop_y)
          )
        )
        (local.set $z (i32.add (local.get $z) (i32.const 1)))
        (br $loop_z)
      )
    )
  )
)
