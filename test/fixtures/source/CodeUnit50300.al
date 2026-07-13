codeunit 50300 "Dangerous Patterns"
{
    procedure CommitInLoop()
    var
        SalesLine: Record "Sales Line";
    begin
        SalesLine.FindSet();
        repeat
            SalesLine.Modify();
            Commit();
        until SalesLine.Next() = 0;
    end;

    procedure ErrorInLoop()
    var
        SalesLine: Record "Sales Line";
    begin
        SalesLine.FindSet();
        repeat
            if SalesLine.Quantity = 0 then
                Error('Quantity cannot be zero');
        until SalesLine.Next() = 0;
    end;

    procedure SafeCommit()
    begin
        // Commit outside loop is fine
        Commit();
    end;

    procedure HttpSendInLoop()
    var
        Client: HttpClient;
        Request: HttpRequestMessage;
        Response: HttpResponseMessage;
        SalesLine: Record "Sales Line";
    begin
        // One network round-trip per iteration -- the most expensive thing an
        // AL developer can accidentally write. A different bug shape from
        // Commit/Error/TestField above: this is a LATENCY problem, not a
        // transactional one, so it gets its own pattern id
        // (external-call-in-loop), not a widened dangerous-call-in-loop.
        SalesLine.FindSet();
        repeat
            Client.Send(Request, Response);
        until SalesLine.Next() = 0;
    end;

    procedure HttpSendNoLoop()
    var
        Client: HttpClient;
        Request: HttpRequestMessage;
        Response: HttpResponseMessage;
    begin
        // A single request outside any loop is exactly what the fix looks
        // like -- must not be flagged.
        Client.Send(Request, Response);
    end;

    procedure HttpGetVsRecordGetInLoop()
    var
        Client: HttpClient;
        Response: HttpResponseMessage;
        Item: Record Item;
        i: Integer;
    begin
        // Get()/Delete() collide with record-op method names by name alone --
        // only the HttpClient-typed variable's Get() may be flagged as
        // external-call-in-loop here. Item.Get() is an ordinary record lookup
        // and belongs to record-op-in-loop, not this detector.
        for i := 1 to 10 do begin
            Item.Get(i);
            Client.Get('https://example.com/api', Response);
        end;
    end;

    procedure HttpMethodsInLoop()
    var
        Client: HttpClient;
        Content: HttpContent;
        Response: HttpResponseMessage;
        i: Integer;
    begin
        // Covers the remaining HttpClient methods besides Send/Get.
        for i := 1 to 10 do begin
            Client.Post('https://example.com/api', Content, Response);
            Client.Put('https://example.com/api', Content, Response);
            Client.Patch('https://example.com/api', Content, Response);
            Client.Delete('https://example.com/api', Response);
        end;
    end;

    procedure SleepInLoop()
    var
        i: Integer;
    begin
        // A bare Sleep() call needs no type resolution -- same bug shape as
        // an HTTP call: N iterations means N blocking delays.
        for i := 1 to 10 do
            Sleep(1000);
    end;
}
