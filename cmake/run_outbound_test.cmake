if(NOT DEFINED TEST_DIR OR NOT DEFINED TTYD_BINARY)
    message(FATAL_ERROR "TEST_DIR and TTYD_BINARY are required")
endif()

find_program(NODE_EXECUTABLE NAMES node REQUIRED)
find_program(NPM_EXECUTABLE NAMES npm REQUIRED)

set(WS_PACKAGE_FILE "${TEST_DIR}/node_modules/ws/package.json")
if(NOT EXISTS "${WS_PACKAGE_FILE}")
    execute_process(
        COMMAND "${NPM_EXECUTABLE}" install
        WORKING_DIRECTORY "${TEST_DIR}"
        RESULT_VARIABLE npm_result
    )
    if(NOT npm_result EQUAL 0)
        message(FATAL_ERROR "npm install failed in ${TEST_DIR}")
    endif()
endif()

execute_process(
    COMMAND "${NODE_EXECUTABLE}" "${TEST_DIR}/test-outbound.js" "${TTYD_BINARY}"
    WORKING_DIRECTORY "${TEST_DIR}"
    RESULT_VARIABLE test_result
)

if(NOT test_result EQUAL 0)
    message(FATAL_ERROR "outbound websocket test failed")
endif()
