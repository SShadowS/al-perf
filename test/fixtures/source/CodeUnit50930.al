codeunit 50930 "Object Level Global Patterns"
{
    var
        GlobalClient: HttpClient;

    procedure ObjectLevelGlobalHttpClientInLoop()
    var
        Request: HttpRequestMessage;
        Response: HttpResponseMessage;
        i: Integer;
    begin
        // KNOWN LIMITATION (Task 9 review, Issue 2): extractVariables() only
        // reads a member's own var_section -- it never sees this object-level
        // `var` section above. buildVariableTypeMap() therefore never learns
        // GlobalClient's declared type here, so the type gate in
        // collectExternalCalls() fails closed and this HttpClient.Send() call
        // is invisible to external-call-in-loop, even though declaring an
        // HttpClient as a global and reusing it across procedures is normal
        // BC code. This is a real, deliberately deferred gap (see
        // buildVariableTypeMap's doc comment in src/source/indexer.ts and
        // CLAUDE.md), pinned here so a future fix to extractVariables's
        // globals handling makes the matching test fail loudly instead of
        // silently continuing to under-report.
        for i := 1 to 10 do
            GlobalClient.Send(Request, Response);
    end;
}
